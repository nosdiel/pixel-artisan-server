import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Play, Pause, Camera, Scissors } from "lucide-react";

export type EditedVideoResult = {
  videoBlob: Blob;
  videoMime: string;
  thumbnailBlob: Blob;
  durationSeconds: number;
  width: number;
  height: number;
};

type Props = {
  file: File | null;
  open: boolean;
  onCancel: () => void;
  onSave: (result: EditedVideoResult) => Promise<void> | void;
};

const RECORDER_MIMES = [
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of RECORDER_MIMES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ }
  }
  return null;
}

function fmt(t: number) {
  if (!Number.isFinite(t)) return "0:00.0";
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

async function captureFrameBlob(video: HTMLVideoElement): Promise<Blob> {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 360;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create thumbnail canvas");
  ctx.drawImage(video, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.88);
  });
}

function seek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener("seeked", done); resolve(); };
    video.addEventListener("seeked", done, { once: true });
    try { video.currentTime = time; } catch { resolve(); }
  });
}

export function VideoEditorDialog({ file, open, onCancel, onSave }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [thumbTime, setThumbTime] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [thumbBlob, setThumbBlob] = useState<Blob | null>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  useEffect(() => {
    return () => { if (thumbUrl) URL.revokeObjectURL(thumbUrl); };
  }, [thumbUrl]);

  const onLoaded = useCallback(async () => {
    const v = videoRef.current; if (!v) return;
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    setDuration(d);
    setStart(0);
    setEnd(d);
    setThumbTime(Math.min(d * 0.1, d));
    // Auto thumbnail at 10%
    try {
      await seek(v, Math.min(d * 0.1, d));
      const b = await captureFrameBlob(v);
      setThumbBlob(b);
      setThumbUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(b); });
      await seek(v, 0);
    } catch { /* ignore */ }
  }, []);

  const togglePlay = useCallback(async () => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) {
      if (v.currentTime < start || v.currentTime >= end) v.currentTime = start;
      try { await v.play(); setPlaying(true); } catch { /* ignore */ }
    } else {
      v.pause(); setPlaying(false);
    }
  }, [start, end]);

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const onTime = () => {
      setCurrentTime(v.currentTime);
      if (v.currentTime >= end && !v.paused) { v.pause(); v.currentTime = start; setPlaying(false); }
    };
    const onPause = () => setPlaying(false);
    const onPlay = () => setPlaying(true);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("pause", onPause);
    v.addEventListener("play", onPlay);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("play", onPlay);
    };
  }, [start, end]);

  const captureThumbnail = useCallback(async () => {
    const v = videoRef.current; if (!v) return;
    const wasPaused = v.paused;
    if (!wasPaused) v.pause();
    try {
      await seek(v, thumbTime);
      const b = await captureFrameBlob(v);
      setThumbBlob(b);
      setThumbUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(b); });
      toast.success("Thumbnail captured");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not capture thumbnail");
    }
  }, [thumbTime]);

  const recordTrim = useCallback(async (): Promise<{ blob: Blob; mime: string }> => {
    const v = videoRef.current;
    if (!v) throw new Error("Video not ready");
    const mime = pickMime();
    if (!mime) throw new Error("MediaRecorder not supported in this browser");
    type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
    const cv = v as CapturableVideo;
    const captureFn = cv.captureStream || cv.mozCaptureStream;
    if (!captureFn) throw new Error("Video stream capture not supported");
    const stream = captureFn.call(cv);
    v.muted = false;
    v.pause();
    await seek(v, start);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const done = new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onerror = (e) => reject((e as ErrorEvent).error ?? new Error("Recorder error"));
      recorder.onstop = () => {
        const outMime = mime.startsWith("video/mp4") ? "video/mp4" : "video/webm";
        if (!chunks.length) reject(new Error("Empty recording"));
        else resolve(new Blob(chunks, { type: outMime }));
      };
    });
    recorder.start(100);
    await v.play();
    const targetDur = Math.max(0.1, end - start);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (v.currentTime >= end || (performance.now() - t0) / 1000 > targetDur + 2) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
    v.pause();
    try { recorder.stop(); } catch { /* ignore */ }
    const blob = await done;
    v.muted = true;
    return { blob, mime: mime.startsWith("video/mp4") ? "video/mp4" : "video/webm" };
  }, [start, end]);

  const handleSave = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !file) return;
    if (end <= start + 0.05) { toast.error("Trim range is too short"); return; }
    setBusy(true);
    const tId = toast.loading("Processing video…");
    try {
      let thumb = thumbBlob;
      if (!thumb) {
        await seek(v, Math.min(thumbTime, end - 0.05));
        thumb = await captureFrameBlob(v);
      }
      const trimmed = await recordTrim();
      const trimmedDur = Math.max(0.1, end - start);
      toast.success("Video ready", { id: tId });
      await onSave({
        videoBlob: trimmed.blob,
        videoMime: trimmed.mime,
        thumbnailBlob: thumb,
        durationSeconds: trimmedDur,
        width: v.videoWidth || 0,
        height: v.videoHeight || 0,
      });
    } catch (e) {
      console.error("[video editor] save failed", e);
      toast.error(e instanceof Error ? e.message : "Could not process video", { id: tId });
    } finally {
      setBusy(false);
    }
  }, [end, start, file, onSave, recordTrim, thumbBlob, thumbTime]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit video</DialogTitle>
          <DialogDescription>Preview, trim, and pick a thumbnail before uploading.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative bg-black rounded-md overflow-hidden">
            {url && (
              <video
                ref={videoRef}
                src={url}
                onLoadedMetadata={onLoaded}
                playsInline
                className="w-full max-h-[50vh] object-contain bg-black"
              />
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={togglePlay} disabled={busy || !duration}>
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              {playing ? "Pause" : "Play trim"}
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              {fmt(currentTime)} / {fmt(duration)}
            </span>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5"><Scissors className="size-3.5" /> Trim</Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {fmt(start)} → {fmt(end)} ({fmt(Math.max(0, end - start))})
              </span>
            </div>
            <Slider
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.05}
              value={[start, end]}
              onValueChange={(v) => {
                if (v.length < 2) return;
                const [a, b] = v;
                setStart(Math.min(a, b - 0.05));
                setEnd(Math.max(b, a + 0.05));
              }}
              disabled={busy || !duration}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5"><Camera className="size-3.5" /> Thumbnail frame</Label>
              <span className="text-xs text-muted-foreground tabular-nums">{fmt(thumbTime)}</span>
            </div>
            <Slider
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.05}
              value={[thumbTime]}
              onValueChange={(v) => setThumbTime(v[0] ?? 0)}
              disabled={busy || !duration}
            />
            <div className="flex items-start gap-3">
              <Button type="button" size="sm" variant="outline" onClick={captureThumbnail} disabled={busy || !duration}>
                <Camera className="size-4" /> Capture frame
              </Button>
              {thumbUrl && (
                <img src={thumbUrl} alt="Thumbnail preview" className="h-20 rounded border" />
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={handleSave} disabled={busy || !duration}>
            {busy ? "Processing…" : "Save & upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}