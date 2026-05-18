# Nini Signage Compressor (Firebase Cloud Functions, gen2)

Compresses images and videos uploaded to the
`nini-signage-renderer.firebasestorage.app` bucket, generates video
thumbnails, and updates the Firestore document at `media/{mediaDocId}`.

## Exports

| Name | Type | Path |
|------|------|------|
| `processMedia`     | HTTPS endpoint            | `POST https://us-central1-nini-signage-renderer.cloudfunctions.net/processMedia` |
| `onMediaUploaded`  | Storage trigger (onFinalize) | runs automatically on every new upload to the bucket |

Both share the same pipeline. The Storage trigger is the “zero‑touch” path;
the HTTPS endpoint is for when the web app wants to call the compressor
explicitly after an upload (e.g. to pass `mediaDocId` reliably).

## Pipeline (per file)

1. Download the original from Storage.
2. **Image**: re-encode with `sharp` (mozjpeg q85 / webp q82 / png palette).
   Cap width at 4096px. Replace the file at the same Storage path.
3. **Video**: re-encode with ffmpeg (`libx264` CRF 26, `aac`, `faststart`,
   scale to ≤1920 wide). Replace the file at the same Storage path. Extract
   a thumbnail at the 10% mark, upload to `thumbnails/<same-path>.jpg`.
4. Write the result to `media/{mediaDocId}` (merge):
   - Images: `url, path, type, size, width, height`
   - Videos: `url, path, type, size, width, height, length,
     thumbnailURL, thumbnailPath`
5. Tag the (re)written object with custom metadata `processed: "true"` so the
   Storage trigger never reprocesses its own output (loop guard). Files under
   `thumbnails/` are also skipped.

## `mediaDocId` resolution

In priority order:

1. `mediaDocId` from the HTTP request body, OR
2. Custom Storage object metadata: `mediaDocId` / `mediaId` / `docId`, OR
3. Filename without extension (last path segment).

**Recommended:** set the doc id as object metadata when uploading from the
web app so the Storage trigger can resolve it without any extra HTTP call:

```ts
await uploadBytes(ref, file, {
  customMetadata: { mediaDocId: mediaRef.id },
});
```

## Calling the HTTPS endpoint from the web app

```ts
await fetch(
  "https://us-central1-nini-signage-renderer.cloudfunctions.net/processMedia",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "uploads/2026/foo.mp4",   // Storage path of the just-uploaded file
      mediaDocId: mediaRef.id,        // Firestore media/{mediaDocId}
      contentType: file.type,         // optional hint
    }),
  },
);
```

Response:

```json
{
  "success": true,
  "kind": "video",
  "mediaDocId": "abc123",
  "url": "https://...",
  "path": "uploads/2026/foo.mp4",
  "type": "video/mp4",
  "size": 1843221,
  "width": 1920,
  "height": 1080,
  "length": 12.36,
  "thumbnailURL": "https://...",
  "thumbnailPath": "thumbnails/uploads/2026/foo.jpg"
}
```

## Local dev

```bash
cd functions
npm install
npm run serve   # firebase emulators
```

## Deploy

From the project root:

```bash
npm install -g firebase-tools      # if needed
firebase login
firebase use nini-signage-renderer
firebase deploy --only functions:compressor
```

The functions run in `us-central1`, 2 GiB memory, 540 s timeout (large
videos). Adjust in `functions/index.js` if needed.

## Costs / quotas

- 2 GiB Functions instance is needed for ffmpeg + sharp on HD video.
- Signed download URLs are issued with a long TTL (~7 years). If you need
  short‑lived URLs, swap `getSignedUrl` for `file.publicUrl()` (requires the
  object to be public) or shorten the `SIGNED_URL_TTL_MS` constant.