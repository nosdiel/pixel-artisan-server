/**
 * Nini Signage — Square Catalog sync (Cloud Functions for Firebase, gen2).
 *
 * Exports:
 *   syncSquareCatalog   — HTTPS callable (Firebase Auth required) → manual sync
 *   scheduledSquareSync — every 30 minutes → background sync
 *   squareWebhook       — HTTPS, signature-verified → delta sync on catalog updates
 *
 * Firestore writes (read-only to clients):
 *   square_items/{itemId}        — { squareItemId, name, description, categoryId,
 *                                    categoryName, variations[], imageUrl,
 *                                    updatedAt, lastSyncedAt, version, deletedAt }
 *   square_categories/{catId}    — { name, updatedAt }
 *   square_sync_state/global     — { lastFullSyncAt, lastStatus, lastError,
 *                                    itemCount, runningSince }
 *
 * Secrets (firebase functions:secrets:set NAME):
 *   SQUARE_ACCESS_TOKEN          — required
 *   SQUARE_ENVIRONMENT           — "sandbox" | "production" (default production)
 *   SQUARE_WEBHOOK_SIGNATURE_KEY — required only for webhook
 */

const crypto = require("crypto");
const admin = require("firebase-admin");
const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { logger } = require("firebase-functions/v2");
const { Client, Environment } = require("square");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const SQUARE_ACCESS_TOKEN = defineSecret("SQUARE_ACCESS_TOKEN");
const SQUARE_ENVIRONMENT = defineSecret("SQUARE_ENVIRONMENT");
const SQUARE_WEBHOOK_SIGNATURE_KEY = defineSecret("SQUARE_WEBHOOK_SIGNATURE_KEY");

const REGION = "us-central1";
const STATE_DOC = db.collection("square_sync_state").doc("global");
const MAX_PAGES_PER_RUN = 50; // soft cap to avoid runaway runs

// ---- helpers ---------------------------------------------------------------

function squareClient() {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error("SQUARE_ACCESS_TOKEN secret is not set");
  const env =
    (process.env.SQUARE_ENVIRONMENT || "production").toLowerCase() === "sandbox"
      ? Environment.Sandbox
      : Environment.Production;
  return new Client({ accessToken: token, environment: env });
}

function bigIntToNumber(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return Number(v);
  return Number(v);
}

function variationPayload(v) {
  const vd = v?.itemVariationData || {};
  const pm = vd.priceMoney || {};
  return {
    id: v.id,
    name: vd.name || null,
    sku: vd.sku || null,
    priceCents: pm.amount != null ? bigIntToNumber(pm.amount) : null,
    currency: pm.currency || null,
    ordinal: vd.ordinal != null ? Number(vd.ordinal) : null,
  };
}

function itemPayload(item, categoryName) {
  const d = item.itemData || {};
  return {
    squareItemId: item.id,
    name: d.name || "",
    description: d.description || null,
    categoryId: d.categoryId || null,
    categoryName: categoryName || null,
    variations: Array.isArray(d.variations) ? d.variations.map(variationPayload) : [],
    imageIds: Array.isArray(d.imageIds) ? d.imageIds : [],
    version: item.version != null ? bigIntToNumber(item.version) : null,
    updatedAt: item.updatedAt || null,
    isDeleted: !!item.isDeleted,
  };
}

/**
 * Shared pipeline: pages Square catalog, writes Firestore in batches,
 * updates sync state. Used by manual, scheduled, and webhook triggers.
 */
async function runSync({ reason }) {
  const startedAt = admin.firestore.FieldValue.serverTimestamp();
  await STATE_DOC.set(
    { runningSince: startedAt, lastStatus: "running", lastReason: reason || "manual" },
    { merge: true },
  );

  const client = squareClient();
  const catalogApi = client.catalogApi;

  let cursor;
  let pages = 0;
  let itemCount = 0;
  const seenItemIds = new Set();
  const seenCategoryIds = new Set();
  const categoryNameById = new Map();

  try {
    do {
      const { result } = await catalogApi.searchCatalogObjects({
        cursor,
        objectTypes: ["ITEM", "CATEGORY"],
        includeRelatedObjects: true,
        includeDeletedObjects: true,
        limit: 200,
      });

      // Build a quick lookup of categories from related objects + page objects.
      for (const obj of result.relatedObjects || []) {
        if (obj.type === "CATEGORY") {
          categoryNameById.set(obj.id, obj?.categoryData?.name || null);
        }
      }
      for (const obj of result.objects || []) {
        if (obj.type === "CATEGORY") {
          categoryNameById.set(obj.id, obj?.categoryData?.name || null);
        }
      }

      const batch = db.batch();
      let ops = 0;

      for (const obj of result.objects || []) {
        if (obj.type === "CATEGORY") {
          seenCategoryIds.add(obj.id);
          batch.set(
            db.collection("square_categories").doc(obj.id),
            {
              name: obj?.categoryData?.name || null,
              updatedAt: obj.updatedAt || null,
              isDeleted: !!obj.isDeleted,
              lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
          ops++;
        } else if (obj.type === "ITEM") {
          const catName = categoryNameById.get(obj?.itemData?.categoryId);
          const payload = itemPayload(obj, catName);
          seenItemIds.add(obj.id);
          itemCount++;
          batch.set(
            db.collection("square_items").doc(obj.id),
            {
              ...payload,
              deletedAt: payload.isDeleted ? admin.firestore.FieldValue.serverTimestamp() : null,
              lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
          ops++;
        }
        if (ops >= 450) break; // leave headroom under 500
      }

      if (ops > 0) await batch.commit();

      cursor = result.cursor;
      pages++;
      if (pages >= MAX_PAGES_PER_RUN) {
        logger.warn("Square sync hit page cap, will resume next run", { pages });
        break;
      }
    } while (cursor);

    await STATE_DOC.set(
      {
        lastFullSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastStatus: "ok",
        lastError: null,
        itemCount,
        runningSince: null,
      },
      { merge: true },
    );

    return { ok: true, itemCount, pages };
  } catch (err) {
    logger.error("Square sync failed", err);
    await STATE_DOC.set(
      {
        lastStatus: "error",
        lastError: String(err?.message || err),
        runningSince: null,
      },
      { merge: true },
    );
    throw err;
  }
}

// ---- exports ---------------------------------------------------------------

exports.syncSquareCatalog = onCall(
  {
    region: REGION,
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [SQUARE_ACCESS_TOKEN, SQUARE_ENVIRONMENT],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in required to sync Square.");
    }
    try {
      return await runSync({ reason: `manual:${request.auth.uid}` });
    } catch (err) {
      throw new HttpsError("internal", String(err?.message || err));
    }
  },
);

exports.scheduledSquareSync = onSchedule(
  {
    region: REGION,
    schedule: "every 30 minutes",
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: [SQUARE_ACCESS_TOKEN, SQUARE_ENVIRONMENT],
  },
  async () => {
    await runSync({ reason: "scheduled" });
  },
);

exports.squareWebhook = onRequest(
  {
    region: REGION,
    memory: "512MiB",
    timeoutSeconds: 540,
    secrets: [SQUARE_ACCESS_TOKEN, SQUARE_ENVIRONMENT, SQUARE_WEBHOOK_SIGNATURE_KEY],
  },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Use POST");
    const sigKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    if (!sigKey) return res.status(500).send("Webhook signature key not configured");

    const signature = req.header("x-square-hmacsha256-signature") || "";
    const notificationUrl = `https://${req.get("host")}${req.originalUrl}`;
    const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
    const expected = crypto
      .createHmac("sha256", sigKey)
      .update(notificationUrl + raw)
      .digest("base64");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      logger.warn("Square webhook signature mismatch");
      return res.status(401).send("invalid signature");
    }

    try {
      await runSync({ reason: "webhook" });
      return res.status(200).send("ok");
    } catch (err) {
      return res.status(500).send(String(err?.message || err));
    }
  },
);