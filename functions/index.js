/**
 * Nini Signage media compressor (Cloud Functions for Firebase, gen2).
 *
 * Two entry points share one pipeline:
 *   1. HTTPS endpoint:  POST  /processMedia
 *        body: { path, mediaDocId?, contentType? }
 *        -> compresses the file at `path` in the default bucket, replaces it
 *           in place, generates a video thumbnail when applicable, then
 *           updates media/{mediaDocId} in Firestore.
 *   2. Storage trigger: onObjectFinalized (any upload to the bucket)
 *        -> same pipeline, with `mediaDocId` resolved from object metadata
 *           (preferred) or derived from the storage path.
 *
 * Firestore fields written to media/{mediaDocId}:
 *   Images: url, path, type, size, width, height
 *   Videos: url, path, type, size, width, height, length,
 *           thumbnailURL, thumbnailPath
 *
 * Notes:
 *   - The original Storage path is preserved (replace-in-place), so existing
 *     `url` / `path` references in the signage app keep working.
 *   - Thumbnails are written under  thumbnails/<basename>.jpg next to the
 *     original (e.g. videos/foo.mp4 -> thumbnails/videos/foo.jpg).
 *   - Re-entry protection: every file we (re)write gets metadata
 *     `processed: "true"` so the Storage trigger ignores its own output.
 *
 * Square Catalog sync lives in a separate codebase at `functions-square/`
 * so the compressor deploys without requiring SQUARE_ACCESS_TOKEN or any
 * other Square-related secrets.
 */

const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const { existsSync } = require("fs");
const crypto = require("crypto");

const admin = require("firebase-admin");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");

const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const BUCKET_NAME = "nini-signage-renderer.firebasestorage.app";
const FIRESTORE_COLLECTION = "media";
const SIGNED_URL_TTL_MS = 7 * 365 * 24 * 60 * 60 * 1000; // ~7 years

admin.initializeApp({ storageBucket: BUCKET_NAME });

const bucket = admin.storage().bucket(BUCKET_NAME);
const firestore = admin.firestore();

// ---------- helpers ----------

function classify(contentType, filePath) {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  const ext = path.extname(filePath || "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"].includes(ext)) return "video";
  return "other";
}

function tmpPath(suffix = "") {
  return path.join(os.tmpdir(), `media-${crypto.randomBytes(8).toString("hex")}${suffix}`);
}

async function getSignedUrl(file) {
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + SIGNED_URL_TTL_MS,
  });
  return url;
}

function createFirebaseDownloadToken() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

function getFirebaseDownloadUrl(storagePath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}

function ffprobe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function resolveMediaDocId({ explicit, metadata, filePath }) {
  if (explicit) return String(explicit);
  const meta = metadata || {};
  if (meta.mediaDocId) return String(meta.mediaDocId);
  if (meta.mediaId) return String(meta.mediaId);
  if (meta.docId) return String(meta.docId);
  // Fallback: derive from filename (last segment without extension).
  const base = path.basename(filePath || "", path.extname(filePath || ""));
  return base || null;
}

// ---------- image pipeline ----------

async function processImage({ file, contentType }) {
  const localIn = tmpPath(path.extname(file.name) || ".bin");
  await file.download({ destination: localIn });

  // Re-encode to a sensible default. Keep PNG transparent images as PNG,
  // everything else becomes high-quality JPEG (we keep the original Storage
  // path/extension, so contentType stays whatever the original was — sharp
  // just produces smaller bytes of the same visual format when possible).
  const ext = path.extname(file.name).toLowerCase();
  const isPng = ext === ".png" || contentType === "image/png";
  const isWebp = ext === ".webp" || contentType === "image/webp";

  let pipeline = sharp(localIn, { failOn: "none" }).rotate(); // honor EXIF orientation
  const meta = await pipeline.metadata();
  // Cap very large images.
  if (meta.width && meta.width > 4096) {
    pipeline = pipeline.resize({ width: 4096, withoutEnlargement: true });
  }
  if (isPng) pipeline = pipeline.png({ compressionLevel: 9, palette: true });
  else if (isWebp) pipeline = pipeline.webp({ quality: 82 });
  else pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });

  const localOut = tmpPath(ext || ".jpg");
  const { width, height, size } = await pipeline.toFile(localOut);

  await bucket.upload(localOut, {
    destination: file.name,
    contentType: contentType || `image/${(ext || ".jpg").slice(1)}`,
    resumable: false,
    metadata: {
      cacheControl: "public, max-age=3600",
      metadata: { processed: "true" },
    },
  });

  const replaced = bucket.file(file.name);
  const url = await getSignedUrl(replaced);

  await fs.unlink(localIn).catch(() => {});
  await fs.unlink(localOut).catch(() => {});

  return {
    kind: "image",
    fields: {
      url,
      path: file.name,
      type: contentType || `image/${(ext || ".jpg").slice(1)}`,
      size,
      width,
      height,
    },
  };
}

// ---------- video pipeline ----------

function compressVideo(localIn, localOut) {
  return new Promise((resolve, reject) => {
    ffmpeg(localIn)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-preset veryfast",
        "-crf 26",
        "-movflags +faststart",
        "-pix_fmt yuv420p",
        "-vf scale='min(1920,iw)':-2",
      ])
      .on("end", () => resolve())
      .on("error", reject)
      .save(localOut);
  });
}

function extractThumbnail(localIn, localOut) {
  return new Promise((resolve, reject) => {
    ffmpeg(localIn)
      .on("end", () => resolve())
      .on("error", reject)
      .screenshots({
        timestamps: ["10%"],
        filename: path.basename(localOut),
        folder: path.dirname(localOut),
        size: "640x?",
      });
  });
}

async function processVideo({ file, contentType }) {
  const originalExt = (path.extname(file.name) || ".mp4").toLowerCase();
  const localIn = tmpPath(originalExt);
  await file.download({ destination: localIn });

  let originalSize = null;
  try {
    const stat = await fs.stat(localIn);
    originalSize = stat.size;
  } catch {
    /* ignore */
  }
  logger.info("video: starting compression", {
    path: file.name,
    originalContentType: contentType || null,
    originalSize,
  });

  // Always produce playable MP4 bytes. ffmpeg writes to a separate temp file
  // so the original object is never touched until ffmpeg succeeds.
  const localOut = tmpPath(".mp4");
  try {
    await compressVideo(localIn, localOut);
  } catch (err) {
    logger.error("video: ffmpeg failed", { path: file.name, error: String(err) });
    await fs.unlink(localIn).catch(() => {});
    await fs.unlink(localOut).catch(() => {});
    throw err;
  }
  let compressedSize = null;
  try {
    const stat = await fs.stat(localOut);
    compressedSize = stat.size;
  } catch {
    /* ignore */
  }
  logger.info("video: ffmpeg success", { path: file.name, compressedSize });

  // Probe the compressed output for accurate width/height/duration.
  const probe = await ffprobe(localOut);
  const vstream = (probe.streams || []).find((s) => s.codec_type === "video") || {};
  const width = vstream.width || null;
  const height = vstream.height || null;
  const length = probe.format && probe.format.duration ? Number(probe.format.duration) : null;

  // Thumbnail.
  const thumbLocal = tmpPath(".jpg");
  await extractThumbnail(localOut, thumbLocal);

  // Force MP4 storage path + content type so the served bytes match what
  // browsers expect. If the source was .webm/.mov/etc the new object lives
  // alongside it at the .mp4 path; we then delete the original to avoid a
  // stale duplicate.
  const finalStoragePath = file.name.replace(/\.[^./]+$/, "") + ".mp4";
  const FINAL_CONTENT_TYPE = "video/mp4";
  const firebaseDownloadToken = createFirebaseDownloadToken();

  await bucket.upload(localOut, {
    destination: finalStoragePath,
    contentType: FINAL_CONTENT_TYPE,
    resumable: false,
    metadata: {
      contentType: FINAL_CONTENT_TYPE,
      contentDisposition: `inline; filename="${path.basename(finalStoragePath)}"`,
      cacheControl: "public, max-age=3600",
      metadata: {
        processed: "true",
        firebaseStorageDownloadTokens: firebaseDownloadToken,
      },
    },
  });
  const replaced = bucket.file(finalStoragePath);

  // Ensure stored metadata.contentType is exactly video/mp4 (some upload
  // paths in GCS preserve the originating header otherwise).
  await replaced.setMetadata({
    contentType: FINAL_CONTENT_TYPE,
    contentDisposition: `inline; filename="${path.basename(finalStoragePath)}"`,
    metadata: {
      processed: "true",
      firebaseStorageDownloadTokens: firebaseDownloadToken,
    },
  });

  const [meta] = await replaced.getMetadata();
  const size = Number(meta.size) || compressedSize || null;
  logger.info("video: uploaded mp4", {
    path: finalStoragePath,
    storedContentType: meta.contentType,
    size,
  });
  if (meta.contentType !== FINAL_CONTENT_TYPE) {
    logger.error("video: storage contentType mismatch", {
      expected: FINAL_CONTENT_TYPE,
      actual: meta.contentType,
      path: finalStoragePath,
    });
  }

  // Delete the original if its path differs (e.g. .webm source).
  if (finalStoragePath !== file.name) {
    try {
      await file.delete({ ignoreNotFound: true });
      logger.info("video: deleted original source", { path: file.name });
    } catch (err) {
      logger.warn("video: failed to delete original source", {
        path: file.name,
        error: String(err),
      });
    }
  }

  const signedUrl = await getSignedUrl(replaced);
  const url = getFirebaseDownloadUrl(finalStoragePath, firebaseDownloadToken);
  logger.info("video: signed url generated", { path: finalStoragePath, signedUrl, firebaseDownloadUrl: url });

  // Upload thumbnail to thumbnails/<same-path>.jpg
  const thumbStoragePath = `thumbnails/${finalStoragePath.replace(/\.[^./]+$/, "")}.jpg`;
  await bucket.upload(thumbLocal, {
    destination: thumbStoragePath,
    contentType: "image/jpeg",
    resumable: false,
    metadata: {
      cacheControl: "public, max-age=3600",
      metadata: { processed: "true", thumbnailFor: finalStoragePath },
    },
  });
  const thumbFile = bucket.file(thumbStoragePath);
  const thumbnailURL = await getSignedUrl(thumbFile);

  await fs.unlink(localIn).catch(() => {});
  await fs.unlink(localOut).catch(() => {});
  await fs.unlink(thumbLocal).catch(() => {});

  return {
    kind: "video",
    fields: {
      url,
      path: finalStoragePath,
      type: FINAL_CONTENT_TYPE,
      size,
      width,
      height,
      length,
      thumbnailURL,
      thumbnailPath: thumbStoragePath,
    },
  };
}

// ---------- shared entry ----------

async function processStoragePath({ storagePath, mediaDocId, contentTypeHint }) {
  if (!storagePath) throw new Error("storagePath is required");
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new Error(`File not found: ${storagePath}`);
  const [meta] = await file.getMetadata();
  const contentType = contentTypeHint || meta.contentType || "";
  const kind = classify(contentType, storagePath);

  // Skip thumbnails and anything we've already processed (loop guard).
  if (storagePath.startsWith("thumbnails/")) {
    return { skipped: "thumbnail-output", storagePath };
  }
  if (meta.metadata && meta.metadata.processed === "true") {
    return { skipped: "already-processed", storagePath };
  }

  let result;
  if (kind === "image") result = await processImage({ file, contentType });
  else if (kind === "video") result = await processVideo({ file, contentType });
  else return { skipped: `unsupported-content-type:${contentType}`, storagePath };

  const docId = resolveMediaDocId({
    explicit: mediaDocId,
    metadata: meta.metadata,
    filePath: storagePath,
  });

  // Resolve companyId / companyMediaId. Priority:
  //   1. Storage object customMetadata (set by uploadEditedMediaToFirebase)
  //   2. Top-level media/{docId} document fields (set by the web client
  //      right after upload, before this trigger fires)
  const customMeta = meta.metadata || {};
  let companyId = customMeta.companyId || null;
  let companyMediaId = customMeta.companyMediaId || null;

  logger.info("processStoragePath: customMetadata snapshot", {
    storagePath,
    customMetadataKeys: Object.keys(customMeta),
    companyIdFromMeta: companyId,
    companyMediaIdFromMeta: companyMediaId,
    mediaDocIdFromMeta: customMeta.mediaDocId || null,
  });

  // Images: if no separate thumbnail is produced, mirror the processed
  // image URL into thumbnail fields so the Android player always has one.
  const fieldsForCompanyDoc = { ...result.fields };
  if (result.kind === "image") {
    fieldsForCompanyDoc.thumbnailURL = result.fields.url;
    fieldsForCompanyDoc.thumbnailPath = result.fields.path;
  }

  if (docId) {
    if (!companyId || !companyMediaId) {
      // The web client writes companyId/companyMediaId into media/{docId}
      // up-front, but on a cold start the trigger can still beat that
      // commit. Retry the read a few times before giving up.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const snap = await firestore.collection(FIRESTORE_COLLECTION).doc(docId).get();
          const data = snap.exists ? snap.data() || {} : {};
          if (!companyId && typeof data.companyId === "string") companyId = data.companyId;
          if (!companyMediaId && typeof data.companyMediaId === "string") companyMediaId = data.companyMediaId;
          if (companyId && companyMediaId) break;
        } catch (err) {
          logger.warn("processStoragePath: failed to read media doc for companyId", {
            docId,
            attempt,
            error: String(err),
          });
        }
        // Backoff: 250ms, 500ms, 1s, 2s, 4s
        await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt)));
      }
      logger.info("processStoragePath: post-fallback companyId resolution", {
        docId,
        companyId,
        companyMediaId,
      });
    }

    await firestore
      .collection(FIRESTORE_COLLECTION)
      .doc(docId)
      .set(
        {
          ...result.fields,
          ...(result.kind === "image"
            ? {
                thumbnailURL: result.fields.url,
                thumbnailPath: result.fields.path,
              }
            : {}),
          state: "ready",
          status: "ready",
          processed: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } else {
    logger.warn("processStoragePath: no mediaDocId resolved; skipping Firestore write", {
      storagePath,
    });
  }

  // Mirror to companies/{companyId}/media/{companyMediaId} — this is the
  // document the Android signage player reads from. It must always end up
  // with the final compressed URL and (for videos) the thumbnail URL.
  if (companyId && companyMediaId) {
    try {
      await firestore
        .collection("companies")
        .doc(companyId)
        .collection("media")
        .doc(companyMediaId)
        .set(
          {
            id: companyMediaId,
            ...fieldsForCompanyDoc,
            state: "ready",
            status: "ready",
            processed: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            processedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      logger.info("Mirrored processed media to company doc", {
        companyId,
        companyMediaId,
        kind: result.kind,
      });
    } catch (err) {
      logger.error("Failed to mirror processed media to company doc", {
        companyId,
        companyMediaId,
        error: String(err),
      });
    }
  } else {
    logger.info("No companyId/companyMediaId resolved; skipping company mirror", {
      storagePath,
      docId,
    });
  }

  return {
    success: true,
    kind: result.kind,
    mediaDocId: docId,
    companyId,
    companyMediaId,
    ...result.fields,
  };
}

// ---------- HTTPS endpoint ----------

exports.processMedia = onRequest(
  {
    region: "us-central1",
    memory: "2GiB",
    timeoutSeconds: 540,
    cors: true,
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(204).send("");
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    try {
      const body = req.body || {};
      const out = await processStoragePath({
        storagePath: body.path,
        mediaDocId: body.mediaDocId,
        contentTypeHint: body.contentType,
      });
      return res.status(200).json(out);
    } catch (err) {
      logger.error("processMedia failed", err);
      return res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  },
);

// ---------- Storage trigger ----------

exports.onMediaUploaded = onObjectFinalized(
  {
    region: "us-central1",
    bucket: BUCKET_NAME,
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    const obj = event.data;
    const storagePath = obj.name;
    const contentType = obj.contentType || "";
    const customMeta = obj.metadata || {};

    if (storagePath && storagePath.startsWith("thumbnails/")) {
      logger.info("Skip thumbnail output", { storagePath });
      return;
    }
    if (customMeta.processed === "true") {
      logger.info("Skip already-processed object", { storagePath });
      return;
    }
    if (classify(contentType, storagePath) === "other") {
      logger.info("Skip non-media object", { storagePath, contentType });
      return;
    }

    try {
      const out = await processStoragePath({
        storagePath,
        mediaDocId: customMeta.mediaDocId || customMeta.mediaId || customMeta.docId,
        contentTypeHint: contentType,
      });
      logger.info("Processed upload", out);
    } catch (err) {
      logger.error("onMediaUploaded failed", { storagePath, err: String(err) });
      throw err;
    }
  },
);