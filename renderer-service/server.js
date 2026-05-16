/**
 * Signage renderer service (Node-side Fabric).
 *
 * Renders template payloads to PNG using fabric/node (node-canvas backend),
 * uploads to Firebase Storage, and updates Firestore. No Puppeteer / no CDN.
 */
const express = require("express");
const admin = require("firebase-admin");
const fabric = require("fabric/node");

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET;
const RENDERER_VERSION = "2026-05-16-fabric7-node";

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
app.use(express.json({ limit: "20mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rendererVersion: RENDERER_VERSION, bucket: BUCKET_NAME, time: new Date().toISOString() });
});

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

app.post("/render", authMiddleware, async (req, res) => {
  const { templateId, companyId, name, width, height, canvasJson } = req.body || {};
  console.log("RENDER PAYLOAD", {
    templateId,
    companyId,
    width,
    height,
    hasCanvasJson: !!canvasJson,
    canvasObjectCount: canvasJson?.objects?.length ?? 0,
  });
  if (!templateId || !companyId || !canvasJson || !width || !height) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  const objectCount = Array.isArray(canvasJson.objects) ? canvasJson.objects.length : 0;
  if (objectCount === 0) {
    return res.status(400).json({ success: false, error: "Template has no objects" });
  }

  const docRef = firestore.collection("rendered_templates").doc(`${companyId}_${templateId}`);
  const startedAt = new Date();

  try {
    await docRef.set(
      { companyId, templateId, name: name || null, status: "rendering", startedAt },
      { merge: true },
    );

    const png = await renderPng({ width, height, canvasJson });

    const ts = startedAt.toISOString().replace(/[:.]/g, "-");
    const latestPath = `rendered/${companyId}/${templateId}/latest.png`;
    const versionPath = `rendered/${companyId}/${templateId}/${ts}.png`;

    const [latestUrl] = await uploadPng(png, latestPath);
    const [versionUrl] = await uploadPng(png, versionPath);

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
        renderedAt: new Date(),
      },
      { merge: true },
    );

    res.json({ success: true, downloadUrl: latestUrl });
  } catch (err) {
    console.error("Render failed:", err);
    await docRef
      .set(
        { status: "error", error: String(err && err.message ? err.message : err), erroredAt: new Date() },
        { merge: true },
      )
      .catch(() => {});
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
});

async function renderPng({ width, height, canvasJson }) {
  const StaticCanvas = fabric.StaticCanvas;
  const canvas = new StaticCanvas(null, {
    width,
    height,
    enableRetinaScaling: false,
    backgroundColor: canvasJson.background || "#ffffff",
    renderOnAddRemove: false,
  });

  console.log("[renderPng] loading JSON", { objects: canvasJson.objects?.length });
  await withTimeout(canvas.loadFromJSON(canvasJson), 120000, "Timed out loading Fabric JSON");

  const allObjects = canvas.getObjects();
  if (allObjects.length === 0) throw new Error("Fabric loaded 0 objects from canvas JSON");

  const visibleOnCanvas = allObjects.filter((obj) => {
    if (obj.visible === false || (obj.opacity ?? 1) <= 0) return false;
    const b = obj.getBoundingRect ? obj.getBoundingRect() : { left: obj.left, top: obj.top, width: obj.width, height: obj.height };
    return b.left < width && b.top < height && b.left + b.width > 0 && b.top + b.height > 0;
  });
  if (visibleOnCanvas.length === 0) {
    throw new Error("Fabric loaded objects, but none are visible within the render canvas");
  }

  canvas.renderAll();
  await new Promise((r) => setTimeout(r, 250));
  canvas.renderAll();

  // Blank-pixel guard
  const ctx = canvas.getContext();
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let nonWhite = 0;
  let painted = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a > 5) {
      painted += 1;
      if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) nonWhite += 1;
    }
  }
  const nonWhiteRatio = painted ? nonWhite / painted : 0;
  if (!painted || nonWhiteRatio < 0.0005) {
    throw new Error(`Rendered PNG is blank (nonWhiteRatio=${nonWhiteRatio.toFixed(6)}, objects=${allObjects.length})`);
  }

  console.log("[renderPng] ready", {
    objects: allObjects.length,
    visibleOnCanvas: visibleOnCanvas.length,
    nonWhiteRatio,
  });

  // node-canvas exposes toBuffer on the underlying canvas element
  const lower = canvas.lowerCanvasEl || canvas.getElement();
  return lower.toBuffer("image/png");
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
  return [url];
}

app.listen(PORT, () => {
  console.log(`Signage renderer v${RENDERER_VERSION} listening on :${PORT} (bucket: ${BUCKET_NAME})`);
});
