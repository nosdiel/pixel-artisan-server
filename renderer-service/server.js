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
const fs = require("fs");

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET;
const CHROME_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome";
const RENDERER_VERSION = "2026-05-16-fabric7-blank-guard";

// Load Fabric.js from node_modules so we don't depend on a CDN at render time.
let FABRIC_SOURCE = "";
try {
  const fabricPath = require.resolve("fabric");
  FABRIC_SOURCE = fs.readFileSync(fabricPath, "utf8");
  console.log(`Loaded local Fabric.js (${FABRIC_SOURCE.length} bytes) from ${fabricPath}`);
} catch (err) {
  console.error("Could not load local Fabric.js:", err.message);
  process.exit(1);
}

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
      protocolTimeout: 180000,
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
  res.json({ ok: true, rendererVersion: RENDERER_VERSION, bucket: BUCKET_NAME, time: new Date().toISOString() });
});

function mimeForUrl(url, fallback = "image/png") {
  const clean = String(url || "").split("?")[0].toLowerCase();
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  return fallback;
}

async function inlineCanvasImages(canvasJson) {
  const json = JSON.parse(JSON.stringify(canvasJson));
  let inlinedImages = 0;
  let inlinedBytes = 0;

  const inlineObject = async (obj) => {
    if (!obj || typeof obj !== "object") return;
    const src = typeof obj.src === "string" ? obj.src : "";
    const isRemoteImage = /^https?:\/\//i.test(src) && !/\.(mp4|mov|m4v|webm|ogg|ogv)(?:$|[?#])/i.test(src);
    if (isRemoteImage) {
      const response = await fetch(src, { redirect: "follow" });
      if (!response.ok) throw new Error(`Could not fetch image layer (${response.status}): ${src.slice(0, 160)}`);
      const contentType = response.headers.get("content-type") || mimeForUrl(src);
      if (!contentType.startsWith("image/")) throw new Error(`Image layer returned ${contentType}: ${src.slice(0, 160)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      obj.src = `data:${contentType};base64,${bytes.toString("base64")}`;
      obj.crossOrigin = "anonymous";
      inlinedImages += 1;
      inlinedBytes += bytes.length;
    }
    await Promise.all((obj.objects || obj._objects || []).map(inlineObject));
    if (obj.clipPath) await inlineObject(obj.clipPath);
  };

  await Promise.all((json.objects || []).map(inlineObject));
  if (json.backgroundImage) await inlineObject(json.backgroundImage);
  return { canvasJson: json, inlinedImages, inlinedBytes };
}

app.post("/render", authMiddleware, async (req, res) => {
  const { templateId, companyId, name, width, height, canvasJson } = req.body || {};
  console.log("RENDER PAYLOAD", {
    templateId,
    companyId,
    width,
    height,
    hasCanvasJson: !!canvasJson,
    objectCount: canvasJson?.objects?.length ?? 0,
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

    const inlined = await inlineCanvasImages(canvasJson);
    console.log("[/render] image sources prepared", {
      templateId,
      inlinedImages: inlined.inlinedImages,
      inlinedBytes: inlined.inlinedBytes,
    });
    const png = await renderPng({ width, height, canvasJson: inlined.canvasJson });

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
    page.setDefaultTimeout(180000);
    page.setDefaultNavigationTimeout(180000);
    page.on("console", (msg) => console.log("[renderer-page]", msg.text()));
    page.on("pageerror", (err) => console.error("[renderer-page-error]", err));
    page.on("requestfailed", (req) => {
      if (req.resourceType() === "image" || req.resourceType() === "font") {
        console.error("[renderer-request-failed]", req.resourceType(), req.url(), req.failure()?.errorText);
      }
    });
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const fabricScriptTag = FABRIC_SOURCE
      ? "" // injected via addScriptTag below
      : `<script src="https://cdn.jsdelivr.net/npm/fabric@7.3.1/dist/index.min.js"></script>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent}
      canvas{display:block}
    </style>
    ${fabricScriptTag}
    </head><body>
    <canvas id="c" width="${width}" height="${height}"></canvas>
    </body></html>`;
    await page.setContent(html, { waitUntil: "networkidle0" });
    if (FABRIC_SOURCE) {
      await page.addScriptTag({ content: FABRIC_SOURCE });
    }

    const renderInfo = await page.evaluate(async (json, renderWidth, renderHeight) => {
      const fabric = window.fabric;
      if (!fabric) throw new Error("Fabric.js failed to load");
      const CanvasClass = fabric.StaticCanvas || fabric.Canvas;
      const canvas = new CanvasClass("c", {
        width: renderWidth,
        height: renderHeight,
        enableRetinaScaling: false,
        backgroundColor: json.background || "#ffffff",
        renderOnAddRemove: false,
      });

      // Wrap loadFromJSON in an explicit Promise; supports both Fabric v5 (callback) and v6 (Promise).
      await new Promise((resolve, reject) => {
        try {
          const result = canvas.loadFromJSON(json, () => resolve());
          if (result && typeof result.then === "function") {
            result.then(() => resolve()).catch(reject);
          }
        } catch (e) {
          reject(e);
        }
      });

      const allObjects = canvas.getObjects();
      if (allObjects.length === 0) throw new Error("Fabric loaded 0 objects from canvas JSON");

      const imageObjects = allObjects.filter((obj) => String(obj.type || "").toLowerCase().includes("image"));
      // Wait per-image with a 10s individual timeout so one slow asset can't hang the render.
      await Promise.all(
        imageObjects.map((obj) => {
          const el = typeof obj.getElement === "function" ? obj.getElement() : null;
          if (!el || el.tagName !== "IMG" || el.complete) return Promise.resolve();
          return new Promise((resolve) => {
            const done = () => resolve();
            el.onload = done;
            el.onerror = done;
            setTimeout(done, 10000);
          });
        }),
      );
      const failedImages = imageObjects
        .map((obj) => {
          const el = typeof obj.getElement === "function" ? obj.getElement() : null;
          const src = typeof obj.getSrc === "function" ? obj.getSrc() : obj.src;
          return { el, src };
        })
        .filter(({ el }) => el && el.tagName === "IMG" && (!el.naturalWidth || !el.naturalHeight))
        .map(({ src }) => String(src || "unknown").slice(0, 160));
      if (failedImages.length) throw new Error(`Image layer failed to load: ${failedImages.join(", ")}`);

      const visibleObjects = allObjects.filter((obj) => obj.visible !== false && (obj.opacity ?? 1) > 0);
      const visibleOnCanvas = visibleObjects.filter((obj) => {
        const bounds = obj.getBoundingRect ? obj.getBoundingRect() : obj;
        return bounds.left < renderWidth && bounds.top < renderHeight && bounds.left + bounds.width > 0 && bounds.top + bounds.height > 0;
      });
      if (visibleOnCanvas.length === 0) {
        throw new Error("Fabric loaded objects, but none are visible within the render canvas");
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
      // Allow Fabric a moment to fully flush text/image rasterization.
      await new Promise((r) => setTimeout(r, 500));
      canvas.renderAll();

      const dataUrl = canvas.toDataURL({ format: "png", multiplier: 1 });
      return {
        loadedCount: allObjects.length,
        visibleOnCanvasCount: visibleOnCanvas.length,
        dataUrl,
        objectSummary: allObjects.map((obj) => ({
          type: obj.type,
          left: obj.left,
          top: obj.top,
          width: obj.width,
          height: obj.height,
          scaleX: obj.scaleX,
          scaleY: obj.scaleY,
          visible: obj.visible,
        })),
      };
    }, canvasJson, width, height);
    console.log("[/render] fabric canvas ready", {
      loadedCount: renderInfo.loadedCount,
      visibleOnCanvasCount: renderInfo.visibleOnCanvasCount,
      objectSummary: renderInfo.objectSummary,
      dataUrlBytes: renderInfo.dataUrl.length,
    });

    return Buffer.from(renderInfo.dataUrl.split(",")[1], "base64");
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