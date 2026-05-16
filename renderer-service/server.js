/**
 * Signage upload service.
 *
 * The browser (Lovable app) renders the Fabric canvas to a PNG and POSTs the
 * base64 bytes here. This service ONLY uploads the PNG to Firebase Storage
 * and updates Firestore. No Puppeteer, no Fabric, no node-canvas.
 */
const express = require("express");
const admin = require("firebase-admin");

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET;
const RENDERER_VERSION = "2026-05-16-browser-render-upload";

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("FIREBASE_SERVICE_ACCOUNT_JSON env var is required");
  process.exit(1);
}
if (!BUCKET_NAME) {
  console.error("FIREBASE_STORAGE_BUCKET env var is required");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: BUCKET_NAME,
});

const bucket = admin.storage().bucket();
const firestore = admin.firestore();

function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) return res.status(401).json({ success: false, error: "Unauthorized" });
  next();
}

const app = express();
app.use(express.json({ limit: "60mb" }));

// CORS — the browser does not call this directly today (the Lovable server
// proxies the upload), but enable it so a future direct call works too.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, rendererVersion: RENDERER_VERSION, bucket: BUCKET_NAME, time: new Date().toISOString() });
});

function decodePngPayload(input) {
  if (!input || typeof input !== "string") throw new Error("pngBase64 is required");
  const stripped = input.startsWith("data:") ? input.slice(input.indexOf(",") + 1) : input;
  const buffer = Buffer.from(stripped, "base64");
  if (buffer.length < 8) throw new Error("PNG payload is too small");
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) {
    if (buffer[i] !== sig[i]) throw new Error("Payload is not a valid PNG (bad signature)");
  }
  return buffer;
}

async function uploadPng(buffer, path) {
  const file = bucket.file(path);
  await file.save(buffer, {
    contentType: "image/png",
    resumable: false,
    metadata: { cacheControl: "public, max-age=60" },
  });
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  return url;
}

app.post("/upload", authMiddleware, async (req, res) => {
  const { templateId, companyId, name, pngBase64, width, height } = req.body || {};
  console.log("UPLOAD PAYLOAD", {
    templateId,
    companyId,
    width,
    height,
    name,
    pngBytesApprox: typeof pngBase64 === "string" ? Math.floor(pngBase64.length * 0.75) : 0,
  });
  if (!templateId || !companyId || !pngBase64) {
    return res.status(400).json({ success: false, error: "Missing templateId, companyId, or pngBase64" });
  }

  const docRef = firestore.collection("rendered_templates").doc(`${companyId}_${templateId}`);
  const startedAt = new Date();
  try {
    let buffer;
    try {
      buffer = decodePngPayload(pngBase64);
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }

    await docRef.set(
      { companyId, templateId, name: name || null, status: "uploading", startedAt },
      { merge: true },
    );

    const ts = startedAt.toISOString().replace(/[:.]/g, "-");
    const latestPath = `rendered/${companyId}/${templateId}/latest.png`;
    const versionPath = `rendered/${companyId}/${templateId}/${ts}.png`;

    const latestUrl = await uploadPng(buffer, latestPath);
    const versionUrl = await uploadPng(buffer, versionPath);

    await docRef.set(
      {
        companyId,
        templateId,
        name: name || null,
        status: "success",
        downloadUrl: latestUrl,
        latestPath,
        versionPath,
        versionUrl,
        width: width ?? null,
        height: height ?? null,
        bytes: buffer.length,
        renderedAt: new Date(),
      },
      { merge: true },
    );

    res.json({ success: true, downloadUrl: latestUrl });
  } catch (err) {
    console.error("Upload failed:", err);
    await docRef
      .set(
        { status: "error", error: String(err && err.message ? err.message : err), erroredAt: new Date() },
        { merge: true },
      )
      .catch(() => {});
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
});

// Backwards-compat: if anything still POSTs to /render with pngBase64, accept it.
app.post("/render", authMiddleware, (req, res) => {
  if (req.body && req.body.pngBase64) {
    req.url = "/upload";
    return app._router.handle(req, res);
  }
  res.status(410).json({
    success: false,
    error: "This service no longer renders Fabric server-side. POST a pre-rendered PNG to /upload as { templateId, companyId, name, pngBase64 }.",
  });
});

app.listen(PORT, () => {
  console.log(`Signage upload service v${RENDERER_VERSION} listening on :${PORT} (bucket: ${BUCKET_NAME})`);
});
