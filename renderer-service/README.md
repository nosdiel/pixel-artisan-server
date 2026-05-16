# Signage Renderer Service

Standalone Node + Puppeteer service that the Lovable app calls to render
templates to PNG, upload to Firebase Storage, and update Firestore.

## Endpoints

- `GET /health` — liveness probe (used by the "Test renderer" button in Settings).
- `POST /render` — body `{ templateId, companyId, name, width, height, canvasJson, squareData }`.
  Returns `{ success, downloadUrl }`.

## Environment variables

| Var | Required | Description |
|-----|----------|-------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | yes | Full service account JSON (single line) from Firebase Console → Project Settings → Service Accounts. |
| `FIREBASE_STORAGE_BUCKET` | yes | e.g. `my-project.appspot.com` |
| `AUTH_TOKEN` | recommended | Shared secret. If set, requests must send `Authorization: Bearer <AUTH_TOKEN>`. Paste the same value in the Lovable app's Settings → Signage publishing. |
| `PUPPETEER_EXECUTABLE_PATH` | no | Defaults to `/usr/bin/google-chrome` in the included Docker image. Set this if your host installs Chrome elsewhere. |
| `PORT` | no | Defaults to `8080`. |

## Storage layout

Each render writes two objects:

```
rendered/{companyId}/{templateId}/latest.png        # always overwritten
rendered/{companyId}/{templateId}/{timestamp}.png   # versioned history
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
  --memory 2Gi \
  --cpu 2 \
  --timeout 120 \
  --set-env-vars "FIREBASE_STORAGE_BUCKET=my-project.appspot.com,AUTH_TOKEN=some-long-random-string" \
  --set-secrets "FIREBASE_SERVICE_ACCOUNT_JSON=firebase-sa:latest" \
  --allow-unauthenticated
```

(Store the service account JSON in Secret Manager as `firebase-sa`.)

Render/Fly/Railway also work — point them at the included `Dockerfile`.
If you deploy without the Dockerfile, make sure Chrome and its Linux libraries are installed; otherwise publish can fail with errors like `libatk-1.0.so.0: cannot open shared object file`.