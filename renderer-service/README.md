# Signage Renderer Service

Standalone Node upload service that receives browser-rendered template PNGs,
uploads them to Firebase Storage, and updates Firestore.

## Endpoints

- `GET /health` — liveness probe (used by the "Test renderer" button in Settings). Must return `rendererVersion: "2026-05-16-video-upload"` after deploying this fix.
- `POST /upload` — body `{ templateId, companyId, name, width, height, pngBase64 }`.
  Returns `{ success, downloadUrl }`.
- `POST /upload-video` — body `{ templateId, companyId, name, width, height, durationMs, mimeType, videoBase64 }`.
  `mimeType` must be `video/mp4` or `video/webm`. Returns `{ success, downloadUrl }`.

## Environment variables

| Var | Required | Description |
|-----|----------|-------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | yes | Full service account JSON (single line) from Firebase Console → Project Settings → Service Accounts. |
| `FIREBASE_STORAGE_BUCKET` | yes | e.g. `my-project.appspot.com` |
| `AUTH_TOKEN` | recommended | Shared secret. If set, requests must send `Authorization: Bearer <AUTH_TOKEN>`. Paste the same value in the Lovable app's Settings → Signage publishing. |
| `PORT` | no | Defaults to `8080`. |

## Storage layout

Each render writes two objects:

```
rendered/{companyId}/{templateId}/latest.png        # always overwritten (image templates)
rendered/{companyId}/{templateId}/{timestamp}.png   # versioned history (image templates)
rendered/{companyId}/{templateId}/latest.{mp4|webm} # video templates
rendered/{companyId}/{templateId}/{timestamp}.{mp4|webm}
```

And a Firestore doc at `rendered_templates/{companyId}_{templateId}` with
`{ status, downloadUrl, latestPath, versionPath, renderedAt, ... }`.

## Local dev

```bash
cd renderer-service
npm install
export FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
export FIREBASE_STORAGE_BUCKET='my-project.appspot.com'
export AUTH_TOKEN='some-long-random-string'
npm run dev
```

Then in the Lovable app: **Settings → Signage publishing**, set
`Renderer URL = http://localhost:8080` and the same `AUTH_TOKEN`.

## Deploy (Cloud Run)

```bash
cd renderer-service
gcloud run deploy signage-renderer \
  --source . \
  --region us-central1 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 120 \
  --set-env-vars "FIREBASE_STORAGE_BUCKET=my-project.appspot.com,AUTH_TOKEN=some-long-random-string" \
  --set-secrets "FIREBASE_SERVICE_ACCOUNT_JSON=firebase-sa:latest" \
  --allow-unauthenticated
```

(Store the service account JSON in Secret Manager as `firebase-sa`.)

Render/Fly/Railway also work — point them at the included `Dockerfile`.

## Verify deployment

After redeploying, open `/health` on the renderer URL. If the response does not include
`"rendererVersion":"2026-05-16-video-upload"`, the app is still calling old render code that does not support `/upload-video`.