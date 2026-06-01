import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Upload, Save, Scissors, Image as ImageIcon, Video as VideoIcon } from "lucide-react";
import { VideoEditorDialog, type EditedVideoResult } from "@/components/VideoEditorDialog";
import {
  uploadEditedMediaToFirebase,
  waitForMediaReady,
  type FirebaseMediaDoc,
} from "@/integrations/firebase/media";
import { ensureFirebaseAuth, getFirebase, getFirebaseInitError } from "@/integrations/firebase/client";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";

type MediaEditorSearch = {
  companyId: string;
  templateId: string;
  mediaDocId?: string;
  companyMediaId?: string;
  returnUrl?: string;
};

export const Route = createFileRoute("/media-editor")({
  validateSearch: (raw: Record<string, unknown>): MediaEditorSearch => ({
    companyId: typeof raw.companyId === "string" ? raw.companyId : "",
    templateId: typeof raw.templateId === "string" ? raw.templateId : "",
    mediaDocId: typeof raw.mediaDocId === "string" ? raw.mediaDocId : undefined,
    companyMediaId:
      typeof raw.companyMediaId === "string"
        ? raw.companyMediaId
        : typeof raw.mediaId === "string"
          ? raw.mediaId
          : typeof raw.mediaDocId === "string"
            ? raw.mediaDocId
            : undefined,
    returnUrl: typeof raw.returnUrl === "string" ? raw.returnUrl : undefined,
  }),
  component: MediaEditorPage,
  head: () => ({
    meta: [
      { title: "Media Editor — NiNi Signage" },
      { name: "description", content: "Upload, trim and prepare media for the NiNi Signage template editor." },
      { name: "robots", content: "noindex" },
    ],
  }),
});

type Stage = "idle" | "selected" | "uploading" | "processing" | "done" | "error";

function captureImageDims(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ width: 0, height: 0 }); };
    img.src = url;
  });
}

async function captureImageThumb(blob: Blob, maxDim = 480): Promise<Blob | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), "image/jpeg", 0.85));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function MediaEditorPage() {
  const { companyId, templateId, mediaDocId, companyMediaId, returnUrl } = Route.useSearch();
  const initError = getFirebaseInitError();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<"image" | "video" | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState<string>("");
  const [videoEdit, setVideoEdit] = useState<EditedVideoResult | null>(null);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [result, setResult] = useState<{
    mediaDocId: string; url: string; thumbnailURL: string | null; path: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canReturn = useMemo(() => {
    if (!returnUrl) return false;
    try {
      const u = new URL(returnUrl);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch { return false; }
  }, [returnUrl]);

  const onPickFile = (f: File | null) => {
    if (!f) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const isVideo = f.type.startsWith("video/");
    const isImage = f.type.startsWith("image/");
    if (!isVideo && !isImage) {
      toast.error("Unsupported file type");
      return;
    }
    setFile(f);
    setKind(isVideo ? "video" : "image");
    setPreviewUrl(URL.createObjectURL(f));
    setVideoEdit(null);
    setResult(null);
    setError(null);
    setStage("selected");
    if (isVideo) setVideoDialogOpen(true);
  };

  const onVideoSave = async (r: EditedVideoResult) => {
    setVideoEdit(r);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(r.videoBlob));
    setVideoDialogOpen(false);
    toast.success("Video trimmed");
  };

  const goBack = (payload: { mediaDocId: string; url: string; thumbnailURL: string | null }) => {
    if (!canReturn || !returnUrl) return;
    try {
      const u = new URL(returnUrl);
      u.searchParams.set("mediaDocId", payload.mediaDocId);
      u.searchParams.set("url", payload.url);
      if (payload.thumbnailURL) u.searchParams.set("thumbnailURL", payload.thumbnailURL);
      if (templateId) u.searchParams.set("templateId", templateId);
      if (companyId) u.searchParams.set("companyId", companyId);
      window.location.assign(u.toString());
    } catch (e) {
      console.error("Invalid returnUrl", e);
    }
  };

  const handleSave = async () => {
    if (!file || !kind) return;
    if (initError) { toast.error(initError); return; }
    setError(null);
    setStage("uploading");
    setProgress("Uploading to Firebase Storage…");
    try {
      let uploadInput;
      if (kind === "video") {
        const v = videoEdit;
        if (!v) {
          toast.error("Please trim/preview the video first");
          setStage("selected");
          return;
        }
        uploadInput = {
          kind: "video" as const,
          blob: v.videoBlob,
          contentType: v.videoMime || "video/mp4",
          thumbnailBlob: v.thumbnailBlob,
          thumbnailContentType: "image/jpeg",
          width: v.width,
          height: v.height,
          durationSeconds: v.durationSeconds,
          name: file.name,
          companyId: companyId || null,
          companyMediaId: companyMediaId || undefined,
        };
      } else {
        const dims = await captureImageDims(file);
        const thumb = await captureImageThumb(file);
        uploadInput = {
          kind: "image" as const,
          blob: file,
          contentType: file.type || "image/jpeg",
          thumbnailBlob: thumb,
          thumbnailContentType: "image/jpeg",
          width: dims.width,
          height: dims.height,
          name: file.name,
          companyId: companyId || null,
          companyMediaId: companyMediaId || undefined,
        };
      }

      console.log("[media-editor] uploadEditedMediaToFirebase input", uploadInput);

      const uploaded = await uploadEditedMediaToFirebase(uploadInput);
      console.log("[media-editor] uploaded", uploaded);

      setStage("processing");
      setProgress("Waiting for Cloud Function to process…");
      const ready: FirebaseMediaDoc = await waitForMediaReady(uploaded.mediaDocId, {
        timeoutMs: 5 * 60 * 1000,
        onUpdate: (d) => setProgress(`Processing… status: ${d.status ?? "pending"}`),
      });

      const finalUrl = (ready.url as string) || uploaded.url;
      const finalThumb = (ready.thumbnailURL as string | null) ?? uploaded.thumbnailURL;
      const finalRes = {
        mediaDocId: uploaded.mediaDocId,
        url: finalUrl,
        thumbnailURL: finalThumb,
        path: (ready.path as string) || uploaded.path,
      };

      // Mirror the processed media into companies/{companyId}/media/{mediaId}
      // so the Nini Renderer can list it for that company. Root media/{id}
      // already exists and is what the compressor wrote to.
      if (companyId) {
        try {
          const fb = getFirebase();
          if (fb) {
            await ensureFirebaseAuth();
            const targetCompanyMediaId = uploaded.companyMediaId || uploaded.mediaDocId;
            const companyMediaRef = doc(
              fb.db,
              "companies",
              companyId,
              "media",
              targetCompanyMediaId,
            );
            await setDoc(
              companyMediaRef,
              {
                id: targetCompanyMediaId,
                mediaDocId: uploaded.mediaDocId,
                url: finalUrl,
                path: finalRes.path,
                thumbnailURL: finalThumb,
                thumbnailPath: (ready.thumbnailPath as string | null) ?? uploaded.thumbnailPath,
                width: ready.width ?? null,
                height: ready.height ?? null,
                length: ready.length ?? null,
                size: ready.size ?? null,
                type: ready.type ?? kind,
                contentType: ready.contentType ?? null,
                status: "ready",
                templateId: templateId || null,
                companyId,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              },
              { merge: true },
            );
          }
        } catch (mirrorErr) {
          console.warn("[media-editor] failed to mirror to companies/{companyId}/media", mirrorErr);
        }
      }

      setResult(finalRes);
      setStage("done");
      toast.success("Media ready");
      if (canReturn) {
        setTimeout(() => goBack(finalRes), 600);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[media-editor] save failed", e);
      setError(msg);
      setStage("error");
      toast.error(msg);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Media Editor</h1>
            <p className="text-xs text-muted-foreground">
              {companyId ? <>Company <span className="font-mono">{companyId}</span> · </> : null}
              {templateId ? <>Template <span className="font-mono">{templateId}</span></> : <>Standalone</>}
              {companyMediaId ? <> · Media <span className="font-mono">{companyMediaId}</span></> : null}
            </p>
          </div>
          {canReturn && result ? (
            <Button variant="outline" onClick={() => goBack(result)}>Return to template</Button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8 space-y-6">
        {initError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {initError}
          </div>
        ) : null}

        <section className="rounded-lg border bg-card p-6">
          <Label className="text-sm font-medium">Choose image or video</Label>
          <div className="mt-3 flex items-center gap-3">
            <Input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              className="max-w-md"
            />
            {kind === "video" && file ? (
              <Button variant="outline" size="sm" onClick={() => setVideoDialogOpen(true)}>
                <Scissors className="size-4 mr-2" /> Re-trim
              </Button>
            ) : null}
          </div>
        </section>

        {previewUrl ? (
          <section className="rounded-lg border bg-card p-6">
            <div className="flex items-center gap-2 mb-3 text-sm text-muted-foreground">
              {kind === "video" ? <VideoIcon className="size-4" /> : <ImageIcon className="size-4" />}
              <span>Preview</span>
            </div>
            <div className="flex justify-center bg-muted/40 rounded-md overflow-hidden">
              {kind === "video" ? (
                <video src={previewUrl} controls className="max-h-[480px] w-auto" />
              ) : (
                <img src={previewUrl} alt="Selected" className="max-h-[480px] w-auto object-contain" />
              )}
            </div>
          </section>
        ) : null}

        {file ? (
          <section className="rounded-lg border bg-card p-6 flex flex-wrap items-center justify-between gap-4">
            <div className="text-sm">
              <div className="font-medium">{file.name}</div>
              <div className="text-muted-foreground">
                {(file.size / 1024 / 1024).toFixed(2)} MB · {file.type || "unknown"}
                {kind === "video" && videoEdit
                  ? ` · trimmed to ${videoEdit.durationSeconds.toFixed(1)}s`
                  : ""}
              </div>
              {stage === "uploading" || stage === "processing" ? (
                <div className="text-xs text-muted-foreground mt-1">{progress}</div>
              ) : null}
              {error ? <div className="text-xs text-destructive mt-1">{error}</div> : null}
            </div>
            <Button
              onClick={handleSave}
              disabled={stage === "uploading" || stage === "processing" || (kind === "video" && !videoEdit)}
            >
              <Save className="size-4 mr-2" />
              {stage === "uploading" ? "Uploading…" : stage === "processing" ? "Processing…" : "Save to Firebase"}
            </Button>
          </section>
        ) : (
          <section className="rounded-lg border border-dashed bg-card/40 p-10 text-center text-sm text-muted-foreground">
            <Upload className="size-6 mx-auto mb-2 opacity-70" />
            Select a file to begin. The processed media will be saved to Firebase Storage
            and registered in <span className="font-mono">media/&#123;mediaDocId&#125;</span>.
          </section>
        )}

        {result ? (
          <section className="rounded-lg border bg-card p-6 space-y-2 text-sm">
            <div className="font-medium">Saved</div>
            <div><span className="text-muted-foreground">mediaDocId:</span> <span className="font-mono">{result.mediaDocId}</span></div>
            <div className="break-all"><span className="text-muted-foreground">url:</span> <a className="text-primary underline" href={result.url} target="_blank" rel="noreferrer">{result.url}</a></div>
            {result.thumbnailURL ? (
              <div className="break-all"><span className="text-muted-foreground">thumbnailURL:</span> <a className="text-primary underline" href={result.thumbnailURL} target="_blank" rel="noreferrer">{result.thumbnailURL}</a></div>
            ) : null}
            {!canReturn ? (
              <p className="text-xs text-muted-foreground pt-2">
                No <span className="font-mono">returnUrl</span> was provided — copy the values above into the signage template.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground pt-2">Redirecting back to the template…</p>
            )}
          </section>
        ) : null}
      </main>

      <VideoEditorDialog
        file={kind === "video" ? file : null}
        open={videoDialogOpen}
        onCancel={() => setVideoDialogOpen(false)}
        onSave={onVideoSave}
      />
    </div>
  );
}