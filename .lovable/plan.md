## Goal
If a template contains a video object, publish the **whole canvas as a video file** (MP4 preferred, WebM fallback) instead of a single PNG. Templates without video keep using the existing PNG path.

## Why MP4 isn't guaranteed
Browser `MediaRecorder` only produces MP4 on Safari/Chrome (recent versions). Everywhere else it emits WebM. We will:
1. Probe `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')` first, then fall back to `video/webm;codecs=vp9` → `video/webm;codecs=vp8`.
2. Upload the bytes with the correct extension + content-type. Firebase stores it as `latest.mp4` or `latest.webm` accordingly; the rendered Firestore doc records the actual mime type so the player can pick the right tag.

## Steps

### 1. Client — detect video and branch (`src/routes/_authenticated/templates.tsx`)
- After `preparePublish`, walk `prep.canvasJson.objects` for any object with `videoStoragePath` or `src` ending in a video extension.
- **No video** → existing PNG flow (unchanged).
- **Has video** → new `recordTemplateVideo()`:
  - Load Fabric `StaticCanvas` like today.
  - For each video object: create an `HTMLVideoElement` (muted, playsInline, crossOrigin anonymous), wait for `loadeddata`, attach to the Fabric `FabricImage`, drive a RAF loop that calls `fc.requestRenderAll()` every frame.
  - Determine `durationSec = max(video.duration)` across all videos, capped at 30s.
  - `canvasEl.captureStream(30)` → `MediaRecorder` with the best supported mime.
  - Start all videos + recorder, stop recorder when the longest video ends, resolve a Blob.
  - Convert blob → base64 → call new `uploadRenderedVideo` server fn.

### 2. Server fn (`src/lib/signage.functions.ts` + `src/lib/signage.server.ts`)
- Add `uploadRenderedVideo` server fn: `{ templateId, videoBase64, mimeType, width, height, durationMs }`.
- In `signage.server.ts`, mirror `uploadRenderedPng` → `uploadRenderedVideoToService`, POSTs to renderer `/upload-video`.

### 3. Renderer service (`renderer-service/server.js`)
- New `POST /upload-video`: validates mime is `video/mp4` or `video/webm`, decodes base64, uploads to `rendered/{companyId}/{templateId}/latest.{ext}` + versioned, writes Firestore `{ status, downloadUrl, mimeType, width, height, durationMs, bytes }`.
- Bump `RENDERER_VERSION` and update `assertRendererSupportsUpload` to accept either the old version or the new one (since older deployments will still serve PNG-only templates). Simpler: bump version and require redeploy — consistent with prior pattern.
- Bump express body limit to handle ~30 MB videos (already at 60 MB, may raise to 120 MB).

### 4. Skip server-side image normalization for video templates
- `prepareTemplateForBrowserRender` already inlines images. For video objects we keep the signed URL (videos can't be base64-inlined cheaply); ensure `refreshCanvasMediaUrls` is video-aware — currently it only touches `imageStoragePath`/image `src`, so videos pass through. Add a parallel pass to refresh `videoStoragePath` → fresh signed URL on the object.

## Technical notes
- Video recording uses canvas-element `captureStream`, not Fabric internals — works with the same StaticCanvas.
- MP4 in-browser without ffmpeg.wasm is only reliable when the browser supports MP4 MediaRecorder. We do not bundle ffmpeg.wasm (large, slow). User accepts WebM fallback.
- Hard 30s cap to keep upload payload reasonable.

## Files touched
- `src/routes/_authenticated/templates.tsx` — branching + new `recordTemplateVideo`
- `src/lib/signage.functions.ts` — new `uploadRenderedVideo` server fn
- `src/lib/signage.server.ts` — new upload helper + refresh video signed URLs
- `renderer-service/server.js` — new `/upload-video` endpoint, version bump
- `renderer-service/README.md` — document new endpoint
