/**
 * Signage upload service.
 *
 * The browser (Lovable app) renders the Fabric canvas to a PNG and POSTs the
 * base64 bytes here. This service ONLY uploads the PNG to Firebase Storage
 * and updates Firestore. No Puppeteer, no Fabric, no node-canvas.
 */
const express = require("express");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET;
const RENDERER_VERSION = "2026-05-16-video-upload";

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
app.use(express.json({ limit: "200mb" }));

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

/**
 * Decode the raw pixel stream from a PNG buffer enough to tell whether
 * every pixel is pure white / fully transparent. We walk IDAT chunks,
 * inflate them, then inspect each scanline's pixel bytes (skipping the
 * 1-byte filter prefix). Supports the bit depths Fabric/browsers emit
 * (8-bit RGB and 8-bit RGBA). Returns { blank, reason }.
 */
function isBlankPng(buffer) {
  try {
    let offset = 8; // skip PNG signature
    let width = 0;
    let height = 0;
    let colorType = -1;
    let bitDepth = 0;
    const idatChunks = [];
    while (offset < buffer.length) {
      const len = buffer.readUInt32BE(offset);
      const type = buffer.slice(offset + 4, offset + 8).toString("ascii");
      const dataStart = offset + 8;
      const dataEnd = dataStart + len;
      if (type === "IHDR") {
        width = buffer.readUInt32BE(dataStart);
        height = buffer.readUInt32BE(dataStart + 4);
        bitDepth = buffer[dataStart + 8];
        colorType = buffer[dataStart + 9];
      } else if (type === "IDAT") {
        idatChunks.push(buffer.slice(dataStart, dataEnd));
      } else if (type === "IEND") {
        break;
      }
      offset = dataEnd + 4; // skip CRC
    }
    if (!width || !height || !idatChunks.length) {
      return { blank: false, reason: "could not parse PNG" };
    }
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
      return { blank: false, reason: `unsupported PNG format (depth=${bitDepth} colorType=${colorType})` };
    }
    const channels = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const stride = width * channels + 1;
    let nonWhite = 0;
    let sampled = 0;
    for (let y = 0; y < height; y++) {
      const rowStart = y * stride + 1; // skip filter byte
      for (let x = 0; x < width; x++) {
        const p = rowStart + x * channels;
        const r = raw[p];
        const g = raw[p + 1];
        const b = raw[p + 2];
        const a = channels === 4 ? raw[p + 3] : 255;
        sampled++;
        if (a !== 0 && (r < 250 || g < 250 || b < 250)) {
          nonWhite++;
          if (nonWhite > 50) return { blank: false, reason: null };
        }
      }
    }
    const ratio = sampled > 0 ? nonWhite / sampled : 0;
    if (ratio < 0.0005) {
      return { blank: true, reason: `nonWhiteRatio=${ratio.toFixed(6)} (${nonWhite}/${sampled})` };
    }
    return { blank: false, reason: null };
  } catch (e) {
    return { blank: false, reason: `blank-check failed: ${e.message}` };
  }
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

    // Persist the decoded PNG to disk for inspection before doing anything
    // else. This makes "blank PNG" bugs trivially debuggable on the server.
    const debugPath = path.join(__dirname, "debug-output.png");
    try {
      fs.writeFileSync(debugPath, buffer);
      console.log(`[upload] wrote debug PNG to ${debugPath} (${buffer.length} bytes)`);
    } catch (e) {
      console.warn(`[upload] could not write ${debugPath}: ${e.message}`);
    }

    const blankCheck = isBlankPng(buffer);
    console.log("[upload] blank check", blankCheck);
    if (blankCheck.blank) {
      await docRef
        .set(
          {
            companyId,
            templateId,
            name: name || null,
            status: "error",
            error: `render produced blank image (${blankCheck.reason})`,
            erroredAt: new Date(),
          },
          { merge: true },
        )
        .catch(() => {});
      return res.status(422).json({
        success: false,
        error: "render produced blank image",
        detail: blankCheck.reason,
        debugPath,
      });
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

// ====== Video upload ======
function decodeVideoPayload(input, mimeType) {
  if (!input || typeof input !== "string") throw new Error("videoBase64 is required");
  if (mimeType !== "video/mp4" && mimeType !== "video/webm") {
    throw new Error(`Unsupported mimeType: ${mimeType}`);
  }
  const stripped = input.startsWith("data:") ? input.slice(input.indexOf(",") + 1) : input;
  const buffer = Buffer.from(stripped, "base64");
  if (buffer.length < 32) throw new Error("Video payload is too small");
  return buffer;
}

async function uploadVideoBuffer(buffer, storagePath, mimeType) {
  const file = bucket.file(storagePath);
  await file.save(buffer, {
    contentType: mimeType,
    resumable: false,
    metadata: { cacheControl: "public, max-age=60" },
  });
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  return url;
}

app.post("/upload-video", authMiddleware, async (req, res) => {
  const { templateId, companyId, name, videoBase64, mimeType, width, height, durationMs } = req.body || {};
  console.log("UPLOAD VIDEO PAYLOAD", {
    templateId,
    companyId,
    width,
    height,
    durationMs,
    mimeType,
    name,
    videoBytesApprox: typeof videoBase64 === "string" ? Math.floor(videoBase64.length * 0.75) : 0,
  });
  if (!templateId || !companyId || !videoBase64 || !mimeType) {
    return res.status(400).json({ success: false, error: "Missing templateId, companyId, mimeType, or videoBase64" });
  }

  const docRef = firestore.collection("rendered_templates").doc(`${companyId}_${templateId}`);
  const startedAt = new Date();
  try {
    let buffer;
    try {
      buffer = decodeVideoPayload(videoBase64, mimeType);
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }

    const ext = mimeType === "video/mp4" ? "mp4" : "webm";
    await docRef.set(
      { companyId, templateId, name: name || null, status: "uploading", startedAt },
      { merge: true },
    );

    const ts = startedAt.toISOString().replace(/[:.]/g, "-");
    const latestPath = `rendered/${companyId}/${templateId}/latest.${ext}`;
    const versionPath = `rendered/${companyId}/${templateId}/${ts}.${ext}`;

    const latestUrl = await uploadVideoBuffer(buffer, latestPath, mimeType);
    const versionUrl = await uploadVideoBuffer(buffer, versionPath, mimeType);

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
        mimeType,
        width: width ?? null,
        height: height ?? null,
        durationMs: durationMs ?? null,
        bytes: buffer.length,
        renderedAt: new Date(),
      },
      { merge: true },
    );

    res.json({ success: true, downloadUrl: latestUrl });
  } catch (err) {
    console.error("Video upload failed:", err);
    await docRef
      .set(
        { status: "error", error: String(err && err.message ? err.message : err), erroredAt: new Date() },
        { merge: true },
      )
      .catch(() => {});
    res.status(500).json({ success: false, error: String(err && err.message ? err.message : err) });
  }
});

app.listen(PORT, () => {
  console.log(`Signage upload service v${RENDERER_VERSION} listening on :${PORT} (bucket: ${BUCKET_NAME})`);
});
