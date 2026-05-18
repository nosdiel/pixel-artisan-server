import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import fixWebmDuration from "fix-webm-duration";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { RefreshCw, AlertCircle, CheckCircle2, UploadCloud, ExternalLink } from "lucide-react";
import {
  listSquareItems,
  listTemplatesWithStatus,
  markTemplateFresh,
  startSquareSyncJob,
  stepSquareSyncJob,
  getLatestSquareSyncJob,
  setTemplateBindings,
  deleteTemplate,
} from "@/lib/square.functions";
import {
  prepareTemplatePublish,
  publishRenderedTemplate,
  publishRenderedVideoTemplate,
  listTemplatesWithPublishStatus,
} from "@/lib/signage.functions";

export const Route = createFileRoute("/_authenticated/templates")({ component: TemplatesPage });

function formatPrice(cents: number | null, currency: string | null) {
  if (cents == null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
  }).format(cents / 100);
}

function isVideoSrc(src: unknown): src is string {
  if (typeof src !== "string") return false;
  return /\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(src);
}

type FabricCanvasObject = {
  src?: unknown;
  videoStoragePath?: unknown;
  videoSrc?: unknown;
  objects?: FabricCanvasObject[];
  _objects?: FabricCanvasObject[];
  clipPath?: FabricCanvasObject;
  left?: unknown;
  top?: unknown;
  width?: unknown;
  height?: unknown;
  scaleX?: unknown;
  scaleY?: unknown;
  angle?: unknown;
  opacity?: unknown;
  originX?: unknown;
  originY?: unknown;
};

type FabricCanvasJson = {
  background?: string;
  objects?: FabricCanvasObject[];
};

function canvasJsonHasVideo(canvasJson: unknown): boolean {
  const visit = (obj: FabricCanvasObject | null | undefined): boolean => {
    if (!obj || typeof obj !== "object") return false;
    if (typeof obj.videoStoragePath === "string" && obj.videoStoragePath) return true;
    if (typeof obj.videoSrc === "string" && obj.videoSrc) return true;
    if (isVideoSrc(obj.src)) return true;
    const children = obj.objects ?? obj._objects ?? [];
    for (const c of children) if (visit(c)) return true;
    if (obj.clipPath && visit(obj.clipPath)) return true;
    return false;
  };
  const root = canvasJson as FabricCanvasJson | null;
  for (const o of root?.objects ?? []) if (visit(o)) return true;
  return false;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

const VIDEO_RECORDING_FPS = 30;
const VIDEO_RECORDING_MIN_SECONDS = 10;
const VIDEO_RECORDING_MAX_SECONDS = 30;
const VIDEO_RECORDING_BITRATE = 3_000_000;

type VideoLayer = {
  video: HTMLVideoElement;
  json: FabricCanvasObject;
};

function pickRecorderMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4;codecs=avc1",
    "video/mp4",
  ];
  return candidates.find(
    (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
  );
}

function waitForAnimationFrames(count: number) {
  return new Promise<void>((resolve) => {
    const step = (remaining: number) => {
      if (remaining <= 0) resolve();
      else requestAnimationFrame(() => step(remaining - 1));
    };
    step(count);
  });
}

function waitForVideoCanPlay(video: HTMLVideoElement, label: string, timeoutMs = 15_000) {
  return new Promise<void>((resolve, reject) => {
    let timeoutId: number | null = null;
    const cleanup = () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("canplay", check);
      video.removeEventListener("error", onError);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Failed to load video for publishing: ${label}`));
    };
    const check = () => {
      if (video.readyState >= 3) {
        cleanup();
        resolve();
      }
    };
    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for video to become playable: ${label}`));
    }, timeoutMs);
    video.addEventListener("loadeddata", check);
    video.addEventListener("canplay", check);
    video.addEventListener("error", onError);
    video.load();
    check();
  });
}

function waitForVideoFrame(video: HTMLVideoElement, label: string, timeoutMs = 5_000) {
  const target = video as HTMLVideoElement;
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      if (error) reject(error);
      else resolve();
    };

    const timeoutId = window.setTimeout(() => {
      finish(new Error(`Timed out waiting for video frame: ${label}`));
    }, timeoutMs);

    const cleanupFinish = (error?: Error) => {
      window.clearTimeout(timeoutId);
      finish(error);
    };

    const requestVideoFrameCallback = (target as any).requestVideoFrameCallback as
      | ((cb: () => void) => number)
      | undefined;
    if (typeof requestVideoFrameCallback === "function") {
      requestVideoFrameCallback.call(target, () => cleanupFinish());
      return;
    }

    const startedAt = performance.now();
    const check = () => {
      if (target.readyState >= 2 && target.currentTime > 0) cleanupFinish();
      else if (performance.now() - startedAt > timeoutMs)
        cleanupFinish(new Error(`Timed out waiting for video frame: ${label}`));
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

async function resolveVideoDuration(video: HTMLVideoElement, fallbackSeconds: number) {
  if (Number.isFinite(video.duration) && video.duration >= fallbackSeconds * 0.75) {
    return video.duration;
  }

  const resolved = await new Promise<number>((resolve) => {
    let timeoutId: number | null = null;
    const cleanup = () => {
      if (timeoutId != null) window.clearTimeout(timeoutId);
      video.removeEventListener("durationchange", done);
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", done);
    };
    const done = () => {
      const duration =
        Number.isFinite(video.duration) && video.duration >= fallbackSeconds * 0.75
          ? video.duration
          : fallbackSeconds;
      cleanup();
      resolve(duration);
    };
    video.addEventListener("durationchange", done);
    video.addEventListener("seeked", done);
    video.addEventListener("error", done);
    timeoutId = window.setTimeout(done, 2_000);
    try {
      video.currentTime = 1e9;
    } catch {
      done();
    }
  });

  try {
    video.currentTime = 0;
  } catch {}
  return resolved;
}

async function verifyRecordedVideoBlob(blob: Blob, expectedSeconds: number) {
  const minBytes = Math.max(600_000, Math.round(expectedSeconds * 60_000));
  if (blob.size < minBytes) {
    throw new Error(
      `Recorded video is too small (${Math.round(blob.size / 1024)} KB). Refusing to upload an invalid render.`,
    );
  }

  const previewUrl = URL.createObjectURL(blob);
  const preview = document.createElement("video");
  preview.src = previewUrl;
  preview.muted = true;
  preview.playsInline = true;
  preview.preload = "auto";
  preview.style.position = "fixed";
  preview.style.left = "-9999px";
  preview.style.top = "0";
  preview.style.width = "1px";
  preview.style.height = "1px";
  preview.style.opacity = "0";
  preview.style.pointerEvents = "none";
  document.body.appendChild(preview);

  try {
    console.info("Local recorded video preview", { previewUrl, size: blob.size, type: blob.type });
    await waitForVideoCanPlay(preview, "local recorded preview");
    const durationSeconds = await resolveVideoDuration(preview, expectedSeconds);
    const minValidDuration = Math.max(VIDEO_RECORDING_MIN_SECONDS - 0.75, expectedSeconds * 0.85);
    if (!Number.isFinite(durationSeconds) || durationSeconds < minValidDuration) {
      throw new Error(
        `Recorded video duration is invalid (${durationSeconds.toFixed(2)}s). Refusing to upload.`,
      );
    }

    preview.currentTime = 0;
    await preview.play();
    await new Promise<void>((resolve, reject) => {
      const startedAt = performance.now();
      const targetTime = Math.min(1, durationSeconds / 4);
      const check = () => {
        if (!preview.paused && preview.currentTime >= targetTime) resolve();
        else if (performance.now() - startedAt > 5_000)
          reject(new Error("Recorded preview did not play locally. Refusing to upload."));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });

    return { durationSeconds, previewUrl };
  } finally {
    try {
      preview.pause();
    } catch {}
    preview.remove();
    window.setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
  }
}

function drawVideoLayer(ctx: CanvasRenderingContext2D, layer: VideoLayer) {
  const obj = layer.json ?? {};
  const video = layer.video;
  const left = Number(obj.left) || 0;
  const top = Number(obj.top) || 0;
  const width = Number(obj.width) || video.videoWidth || video.clientWidth || 1;
  const height = Number(obj.height) || video.videoHeight || video.clientHeight || 1;
  const scaleX = Number(obj.scaleX) || 1;
  const scaleY = Number(obj.scaleY) || 1;
  const angle = ((Number(obj.angle) || 0) * Math.PI) / 180;
  const opacity = Number.isFinite(Number(obj.opacity)) ? Number(obj.opacity) : 1;
  const originX = obj.originX === "center" ? width / 2 : obj.originX === "right" ? width : 0;
  const originY = obj.originY === "center" ? height / 2 : obj.originY === "bottom" ? height : 0;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(left + originX * scaleX, top + originY * scaleY);
  ctx.rotate(angle);
  ctx.scale(scaleX, scaleY);
  ctx.drawImage(video, -originX, -originY, width, height);
  ctx.restore();
}

function TemplatesPage() {
  const qc = useQueryClient();
  const fetchItems = useServerFn(listSquareItems);
  const fetchTemplates = useServerFn(listTemplatesWithStatus);
  const fresh = useServerFn(markTemplateFresh);
  const startJob = useServerFn(startSquareSyncJob);
  const stepJob = useServerFn(stepSquareSyncJob);
  const fetchLatestJob = useServerFn(getLatestSquareSyncJob);
  const saveBindings = useServerFn(setTemplateBindings);
  const deleteTpl = useServerFn(deleteTemplate);
  const preparePublish = useServerFn(prepareTemplatePublish);
  const uploadRendered = useServerFn(publishRenderedTemplate);
  const uploadRenderedVideo = useServerFn(publishRenderedVideoTemplate);
  const fetchPublishStatus = useServerFn(listTemplatesWithPublishStatus);

  const itemsQ = useQuery({ queryKey: ["square-items"], queryFn: () => fetchItems() });
  const tplQ = useQuery({ queryKey: ["templates"], queryFn: () => fetchTemplates() });
  const latestJobQ = useQuery({ queryKey: ["sync-job-latest"], queryFn: () => fetchLatestJob() });
  const publishStatusQ = useQuery({
    queryKey: ["templates-publish-status"],
    queryFn: () => fetchPublishStatus(),
  });

  const publishM = useMutation({
    mutationFn: (templateId: string) => publishTemplateInBrowser(templateId),
    onSuccess: (r) => {
      toast.success(r.downloadUrl ? "Published to Firebase" : "Renderer accepted job");
      qc.invalidateQueries({ queryKey: ["templates-publish-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Render the saved template canvas into a hidden Fabric StaticCanvas in
  // the browser, export PNG, then send the bytes to the upload service.
  async function publishTemplateInBrowser(templateId: string) {
    const prep = await preparePublish({ data: { templateId } });
    if (!prep?.canvasJson) throw new Error("Template has no canvas data");

    if (canvasJsonHasVideo(prep.canvasJson)) {
      return await recordTemplateVideo(templateId, prep);
    }

    const fabric = await import("fabric");
    const canvasEl = document.createElement("canvas");
    canvasEl.width = prep.width;
    canvasEl.height = prep.height;
    canvasEl.style.position = "fixed";
    canvasEl.style.left = "-9999px";
    canvasEl.style.top = "0";
    canvasEl.style.width = "1px";
    canvasEl.style.height = "1px";
    canvasEl.style.opacity = "0";
    canvasEl.style.pointerEvents = "none";
    document.body.appendChild(canvasEl);
    const staticCanvas = new fabric.StaticCanvas(canvasEl, {
      width: prep.width,
      height: prep.height,
      enableRetinaScaling: false,
      backgroundColor: (prep.canvasJson as { background?: string }).background ?? "#ffffff",
      renderOnAddRemove: false,
    });

    try {
      await staticCanvas.loadFromJSON(prep.canvasJson);
      const objs = staticCanvas.getObjects();
      if (objs.length === 0) throw new Error("Fabric loaded 0 objects");
      // Wait a tick so any image elements decode before render.
      await new Promise((r) => setTimeout(r, 50));
      staticCanvas.renderAll();
      await new Promise((r) => setTimeout(r, 200));
      staticCanvas.renderAll();

      const dataUrl = staticCanvas.toDataURL({
        format: "png",
        multiplier: 1,
        enableRetinaScaling: false,
      });
      const pngBase64 = dataUrl.startsWith("data:")
        ? dataUrl.slice(dataUrl.indexOf(",") + 1)
        : dataUrl;
      if (!pngBase64 || pngBase64.length < 64) {
        throw new Error("Browser produced an empty PNG");
      }

      return await uploadRendered({
        data: {
          templateId,
          pngBase64,
          width: prep.width,
          height: prep.height,
        },
      });
    } finally {
      staticCanvas.dispose();
    }
  }

  // ====== Video recording flow ======
  async function recordTemplateVideo(
    templateId: string,
    prep: { width: number; height: number; canvasJson: any },
  ) {
    const fabric = await import("fabric");
    const canvasEl = document.createElement("canvas");
    canvasEl.width = prep.width;
    canvasEl.height = prep.height;
    const staticCanvas = new fabric.StaticCanvas(canvasEl, {
      width: prep.width,
      height: prep.height,
      enableRetinaScaling: false,
      backgroundColor: (prep.canvasJson as { background?: string }).background ?? "#ffffff",
      renderOnAddRemove: false,
    });

    const videos: HTMLVideoElement[] = [];
    const videoLayers: VideoLayer[] = [];
    let rafId: number | null = null;
    let recorder: MediaRecorder | null = null;

    try {
      await staticCanvas.loadFromJSON(prep.canvasJson);
      const objs = staticCanvas.getObjects();
      if (objs.length === 0) throw new Error("Fabric loaded 0 objects");

      // For every object that originated from a video, swap its FabricImage
      // backing element to an HTMLVideoElement that plays the signed URL.
      const attachVideos = async (jsonList: any[], fabricList: any[]) => {
        for (let i = 0; i < jsonList.length; i++) {
          const j = jsonList[i];
          const fabricObj = fabricList[i];
          const videoSrc: string | undefined =
            j?.videoSrc || (isVideoSrc(j?.src) ? j.src : undefined);

          if (videoSrc && fabricObj instanceof fabric.FabricImage) {
            const v = document.createElement("video");
            v.crossOrigin = "anonymous";
            v.muted = true;
            v.playsInline = true;
            v.loop = true;
            v.preload = "auto";
            v.src = videoSrc;
            v.style.position = "fixed";
            v.style.left = "-9999px";
            v.style.top = "0";
            v.style.width = "1px";
            v.style.height = "1px";
            v.style.opacity = "0";
            v.style.pointerEvents = "none";
            document.body.appendChild(v);
            await waitForVideoCanPlay(v, videoSrc);
            (fabricObj as any).setElement(v);
            (fabricObj as any).objectCaching = false;
            videos.push(v);
            videoLayers.push({ video: v, json: j });
          }

          const childJson = (j?.objects ?? j?._objects ?? []) as any[];
          const childFabric =
            typeof fabricObj?.getObjects === "function" ? fabricObj.getObjects() : [];
          if (childJson.length && childFabric.length) await attachVideos(childJson, childFabric);
        }
      };

      await attachVideos((prep.canvasJson.objects ?? []) as any[], objs as any[]);

      if (videos.length === 0) throw new Error("No playable videos found on canvas");

      const durations = await Promise.all(
        videos.map((v) => resolveVideoDuration(v, VIDEO_RECORDING_MIN_SECONDS)),
      );
      const hasPlayableDuration = durations.some(
        (duration) => Number.isFinite(duration) && duration > 0,
      );
      const maxDur = hasPlayableDuration
        ? Math.min(
            VIDEO_RECORDING_MAX_SECONDS,
            Math.max(VIDEO_RECORDING_MIN_SECONDS, VIDEO_RECORDING_MIN_SECONDS),
          )
        : VIDEO_RECORDING_MIN_SECONDS;

      const stream = (canvasEl as HTMLCanvasElement).captureStream(VIDEO_RECORDING_FPS);
      const canvasTrack = stream.getVideoTracks()[0] as MediaStreamTrack & {
        requestFrame?: () => void;
      };
      const requestCanvasFrame =
        typeof canvasTrack?.requestFrame === "function" ? () => canvasTrack.requestFrame?.() : null;

      // RAF loop: keep re-rendering so videos animate, and explicitly push
      // canvas frames when the browser exposes CanvasCaptureMediaStreamTrack.
      const ctx = canvasEl.getContext("2d");
      if (!ctx) throw new Error("Could not create video recording canvas context");
      const renderFrame = () => {
        staticCanvas.renderAll();
        for (const layer of videoLayers) drawVideoLayer(ctx, layer);
        requestCanvasFrame?.();
      };
      const tick = () => {
        renderFrame();
        rafId = requestAnimationFrame(tick);
      };
      renderFrame();
      rafId = requestAnimationFrame(tick);

      const recorderMime = pickRecorderMimeType();
      if (!recorderMime) throw new Error("Browser does not support MediaRecorder for video output");

      recorder = new MediaRecorder(stream, {
        mimeType: recorderMime,
        videoBitsPerSecond: VIDEO_RECORDING_BITRATE,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };

      const recordingDone = new Promise<Blob>((resolve, reject) => {
        recorder!.onstop = () => {
          const outMime = recorderMime.startsWith("video/mp4") ? "video/mp4" : "video/webm";
          if (chunks.length === 0) reject(new Error("MediaRecorder produced no video chunks"));
          else resolve(new Blob(chunks, { type: outMime }));
        };
        recorder!.onerror = (e) =>
          reject(new Error(`MediaRecorder error: ${String((e as any).error?.message || e)}`));
      });

      // Start playback FIRST so the stream has frames, then start recording.
      // Loop videos so even a 1s clip records the full window without ending
      // the stream prematurely. We stop strictly via wall-clock timer.
      videos.forEach((v) => {
        v.loop = true;
        try {
          v.currentTime = 0;
        } catch {
          // Ignore browsers that delay seeking until more data is buffered.
        }
      });
      await Promise.all(videos.map((v) => waitForVideoCanPlay(v, v.currentSrc || v.src)));
      await Promise.all(videos.map((v) => v.play()));
      await Promise.all(videos.map((v) => waitForVideoFrame(v, v.currentSrc || v.src)));
      // Give the canvas a couple of frames before opening the recorder.
      await waitForAnimationFrames(3);
      renderFrame();
      recorder.start(250);
      window.setTimeout(
        () => {
          try {
            if (recorder?.state === "recording") {
              recorder.requestData();
              recorder.stop();
            }
          } catch {
            // Ignore recorder cleanup races.
          }
        },
        Math.ceil(maxDur * 1000),
      );

      const blob = await recordingDone;
      const mimeOut: "video/mp4" | "video/webm" = recorderMime.startsWith("video/mp4")
        ? "video/mp4"
        : "video/webm";
      const uploadBlob =
        mimeOut === "video/webm"
          ? await fixWebmDuration(blob, Math.round(maxDur * 1000), { logger: false })
          : blob;
      const verified = await verifyRecordedVideoBlob(uploadBlob, maxDur);
      toast.success(
        `Local video preview verified (${verified.durationSeconds.toFixed(1)}s, ${Math.round(uploadBlob.size / 1024)} KB)`,
      );
      const base64 = await blobToBase64(uploadBlob);
      return await uploadRenderedVideo({
        data: {
          templateId,
          videoBase64: base64,
          mimeType: mimeOut,
          width: prep.width,
          height: prep.height,
          durationMs: Math.round(verified.durationSeconds * 1000),
        },
      });
    } finally {
      if (rafId != null) cancelAnimationFrame(rafId);
      try {
        if (recorder?.state === "recording") recorder.stop();
      } catch {
        // Ignore cleanup races after MediaRecorder has already stopped.
      }
      videos.forEach((v) => {
        try {
          v.pause();
          v.src = "";
          v.load();
          v.remove();
        } catch {
          // Best-effort cleanup for detached media elements.
        }
      });
      staticCanvas.dispose();
      canvasEl.remove();
    }
  }

  const publishById = new Map((publishStatusQ.data?.rows ?? []).map((r) => [r.id, r] as const));

  const [running, setRunning] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const cancelRef = useRef(false);

  // Resume an in-flight job if the page was reloaded mid-sync
  useEffect(() => {
    const job = latestJobQ.data?.job;
    if (job?.status === "running" && !running) {
      setActiveJobId(job.id);
      setProcessed(job.processed_items);
      runJobLoop(job.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestJobQ.data?.job?.id]);

  async function runJobLoop(jobId: string) {
    setRunning(true);
    cancelRef.current = false;
    try {
      while (!cancelRef.current) {
        const r = await stepJob({ data: { jobId } });
        setProcessed(r.processed);
        if (r.done) {
          if (r.status === "succeeded") {
            const updated = r.updatedCount ?? 0;
            const stale = r.staleCount ?? 0;
            const parts = [`Synced ${r.processed} items`];
            if (updated) parts.push(`${updated} template${updated === 1 ? "" : "s"} auto-updated`);
            if (stale) parts.push(`${stale} flagged stale`);
            toast.success(parts.join(" · "));
          }
          break;
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setActiveJobId(null);
      qc.invalidateQueries({ queryKey: ["square-items"] });
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["sync-job-latest"] });
    }
  }

  async function handleStart() {
    try {
      setProcessed(0);
      const { jobId } = await startJob();
      setActiveJobId(jobId);
      runJobLoop(jobId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const freshM = useMutation({
    mutationFn: (templateId: string) => fresh({ data: { templateId } }),
    onSuccess: () => {
      toast.success("Template marked fresh");
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteM = useMutation({
    mutationFn: (templateId: string) => deleteTpl({ data: { templateId } }),
    onSuccess: () => {
      toast.success("Template deleted");
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const bindM = useMutation({
    mutationFn: (vars: { templateId: string; squareItemIds: string[] }) =>
      saveBindings({ data: vars }),
    onSuccess: () => {
      toast.success("Bindings saved");
      qc.invalidateQueries({ queryKey: ["templates"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openEdit = (t: { id: string; name: string; square_bindings: unknown }) => {
    const bindings = (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
    setSelected(new Set(bindings.map((b) => b.square_item_id)));
    setSearch("");
    setEditing({ id: t.id, name: t.name });
  };

  const filteredItems = (itemsQ.data?.items ?? []).filter((it) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (it.name ?? "").toLowerCase().includes(q) || it.square_item_id.toLowerCase().includes(q);
  });

  const lastJob = latestJobQ.data?.job;

  return (
    <div className="p-8 max-w-5xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Templates &amp; Square sync</h1>
          <p className="text-muted-foreground mt-1">
            Bind Square catalog items to templates. We flag templates as stale when prices change.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button onClick={handleStart} disabled={running} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
              {running ? "Syncing…" : "Sync Square catalog"}
            </Button>
            {running && (
              <Button
                variant="outline"
                onClick={() => {
                  cancelRef.current = true;
                }}
              >
                Stop
              </Button>
            )}
          </div>
          {!running && lastJob && (
            <p className="text-xs text-muted-foreground">
              Last sync: {lastJob.status} · {lastJob.processed_items} items
              {lastJob.finished_at ? ` · ${new Date(lastJob.finished_at).toLocaleString()}` : ""}
            </p>
          )}
        </div>
      </div>

      {(running || activeJobId) && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-medium">Background sync in progress</span>
            <span className="tabular-nums text-muted-foreground">{processed} items processed</span>
          </div>
          <div className="h-2 w-full rounded-full bg-primary/15 overflow-hidden">
            <div className="h-full w-1/3 bg-primary animate-[indeterminate_1.4s_ease-in-out_infinite]" />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            You can navigate away — the sync will resume if you return before it finishes.
          </p>
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="font-semibold mb-3">Templates</h2>
        {tplQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !tplQ.data?.templates.length ? (
          <p className="text-sm text-muted-foreground">
            No templates yet. Create one from the Editor.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {tplQ.data.templates.map((t) => {
              const bindings =
                (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
              return (
                <li key={t.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{t.name}</span>
                      <Badge variant="secondary">{t.preset}</Badge>
                      {t.is_stale ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertCircle className="h-3 w-3" />
                          Stale
                        </Badge>
                      ) : (
                        <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15">
                          <CheckCircle2 className="h-3 w-3" />
                          Fresh
                        </Badge>
                      )}
                      {(() => {
                        const ps = publishById.get(t.id);
                        if (!ps?.last_publish_status) return null;
                        if (ps.last_publish_status === "success") {
                          return (
                            <Badge className="gap-1 bg-blue-500/15 text-blue-600 hover:bg-blue-500/15">
                              <UploadCloud className="h-3 w-3" />
                              Published
                            </Badge>
                          );
                        }
                        return (
                          <Badge
                            variant="destructive"
                            className="gap-1"
                            title={ps.last_publish_error ?? ""}
                          >
                            <AlertCircle className="h-3 w-3" />
                            Publish failed
                          </Badge>
                        );
                      })()}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {bindings.length} Square binding{bindings.length === 1 ? "" : "s"}
                      {(() => {
                        const ps = publishById.get(t.id);
                        if (!ps?.last_published_at) return null;
                        return (
                          <>
                            {" · Last published "}
                            {new Date(ps.last_published_at).toLocaleString()}
                            {ps.last_published_url && (
                              <a
                                href={ps.last_published_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-0.5 ml-1 underline"
                              >
                                view <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </>
                        );
                      })()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" asChild>
                      <Link to="/editor" search={{ template: t.id }}>
                        Edit
                      </Link>
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => openEdit(t)}>
                      Edit bindings
                    </Button>
                    {t.is_stale && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => freshM.mutate(t.id)}
                        disabled={freshM.isPending}
                      >
                        Mark fresh
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      onClick={() => publishM.mutate(t.id)}
                      disabled={publishM.isPending}
                    >
                      <UploadCloud className="h-4 w-4" />
                      {publishM.isPending && publishM.variables === t.id
                        ? "Publishing…"
                        : "Publish"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm(`Delete template "${t.name}"? This cannot be undone.`)) {
                          deleteM.mutate(t.id);
                        }
                      }}
                      disabled={deleteM.isPending}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="font-semibold mb-3">Square catalog cache</h2>
        {itemsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !itemsQ.data?.items.length ? (
          <p className="text-sm text-muted-foreground">
            No cached items. Connect Square in Settings, then click Sync.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Item</th>
                  <th className="py-2 pr-4">Price</th>
                  <th className="py-2 pr-4">ID</th>
                </tr>
              </thead>
              <tbody>
                {itemsQ.data.items.map((it) => (
                  <tr key={it.square_item_id} className="border-t border-border">
                    <td className="py-2 pr-4">{it.name ?? "—"}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {formatPrice(it.price_cents, it.currency)}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {it.square_item_id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bind Square items</DialogTitle>
            <DialogDescription>
              {editing
                ? `Choose catalog items to bind to "${editing.name}". Templates go stale when a bound item's price changes.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Search items by name or ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border">
            {!itemsQ.data?.items.length ? (
              <p className="p-4 text-sm text-muted-foreground">
                No cached Square items. Run a sync first.
              </p>
            ) : !filteredItems.length ? (
              <p className="p-4 text-sm text-muted-foreground">No matches.</p>
            ) : (
              <ul className="divide-y divide-border">
                {filteredItems.map((it) => {
                  const checked = selected.has(it.square_item_id);
                  return (
                    <li key={it.square_item_id} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(it.square_item_id);
                            else next.delete(it.square_item_id);
                            return next;
                          });
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{it.name ?? "—"}</p>
                        <p className="font-mono text-xs text-muted-foreground truncate">
                          {it.square_item_id}
                        </p>
                      </div>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {formatPrice(it.price_cents, it.currency)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditing(null)} disabled={bindM.isPending}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  editing &&
                  bindM.mutate({ templateId: editing.id, squareItemIds: Array.from(selected) })
                }
                disabled={bindM.isPending}
              >
                {bindM.isPending ? "Saving…" : "Save bindings"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
