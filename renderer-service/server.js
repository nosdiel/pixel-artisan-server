/**
 * Signage renderer service.
 *
 * Receives template payloads from the Lovable app, renders them to PNG using
 * a headless browser + Fabric.js, uploads the PNG to Firebase Storage, and
 * writes/updates a Firestore document with the public download URL.
 *
 * Endpoints:
 *   GET  /health        — liveness probe
 *   POST /render        — render + upload + Firestore update
 *
 * Env vars:
 *   PORT                          — defaults to 8080
 *   AUTH_TOKEN                    — optional shared secret. If set, requests must
 *                                   send `Authorization: Bearer <AUTH_TOKEN>`.
 *   FIREBASE_SERVICE_ACCOUNT_JSON — full Firebase service account JSON (single line).
 *   FIREBASE_STORAGE_BUCKET       — e.g. my-project.appspot.com
 */
const express = require("express");
const admin = require("firebase-admin");
const puppeteer = require("puppeteer");

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET;
const CHROME_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome";

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

// Reuse a single browser process across requests
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      executablePath: CHROME_EXECUTABLE_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browserPromise;
}

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
  res.json({ ok: true, bucket: BUCKET_NAME, time: new Date().toISOString() });
});

app.post("/render", authMiddleware, async (req, res) => {
  const { templateId, companyId, name, width, height, canvasJson } = req.body || {};
  if (!templateId || !companyId || !canvasJson || !width || !height) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const objectCount = Array.isArray(canvasJson.objects) ? canvasJson.objects.length : 0;
  console.log("[/render]", {
    templateId,
    companyId,
    name,
    width,
    height,
    objectCount,
    canvasJsonPreview: JSON.stringify(canvasJson).slice(0, 500),
  });
  if (objectCount === 0) {
    return res.status(400).json({ success: false, error: "Template has no objects." });
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
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent}
      canvas{display:block}
    </style>
    <script src="https://cdn.jsdelivr.net/npm/fabric@6.5.1/dist/index.min.js"></script>
    </head><body>
    <canvas id="c" width="${width}" height="${height}"></canvas>
    </body></html>`;
    await page.setContent(html, { waitUntil: "networkidle0" });

    const loadedCount = await page.evaluate(async (json) => {
      const fabric = window.fabric;
      if (!fabric) throw new Error("Fabric.js failed to load from CDN");
      const canvas = new fabric.Canvas("c", { enableRetinaScaling: false });

      // Fabric v6: loadFromJSON returns a Promise
      const result = canvas.loadFromJSON(json);
      if (result && typeof result.then === "function") {
        await result;
      } else {
        await new Promise((resolve) => canvas.loadFromJSON(json, resolve));
      }

      // Wait for any <img> resources referenced by fabric objects to finish loading
      const imgs = Array.from(document.images || []);
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((r) => { img.onload = img.onerror = r; }),
        ),
      );

      // Wait for fonts (custom or web fonts used in text objects)
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch {}
      }

      canvas.renderAll();
      // One more tick to flush
      await new Promise((r) => setTimeout(r, 100));
      canvas.renderAll();

      return canvas.getObjects().length;
    }, canvasJson);
    console.log(`[/render] fabric loaded ${loadedCount} objects on canvas`);

    const buf = await page.screenshot({ type: "png", omitBackground: false, clip: { x: 0, y: 0, width, height } });
    return buf;
  } finally {
    await page.close().catch(() => {});
  }
}

async function uploadPng(buffer, path) {
  const file = bucket.file(path);
  await file.save(buffer, {
    contentType: "image/png",
    resumable: false,
    metadata: { cacheControl: "public, max-age=60" },
  });
  // Long-lived signed URL (7 days max for v4 signing). For permanent URLs make
  // the file public or generate Firebase download tokens.
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  return [url];
}

app.listen(PORT, () => {
  console.log(`Signage renderer listening on :${PORT} (bucket: ${BUCKET_NAME})`);
});