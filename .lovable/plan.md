## Square × Firebase × Lovable pricing integration

Goal: Square Catalog flows through Firebase (secure backend, sync + storage), and the Lovable editor reads from Firestore and binds Square items to template fields with safe local overrides.

---

### 1. Firebase backend (in `functions/` — same project as the compressor)

Add a second codebase / function set alongside the existing `compressor`:

**Credentials**
- Store Square credentials as Cloud Functions secrets (`firebase functions:secrets:set`):
  - `SQUARE_ACCESS_TOKEN`
  - `SQUARE_ENVIRONMENT` (`sandbox` | `production`)
  - `SQUARE_LOCATION_ID` (optional, for location-scoped pricing)
- Never expose these to the client. Only Cloud Functions read them.

**Firestore collections**
- `square_items/{itemId}` — one doc per Square `ITEM`
  - `squareItemId`, `name`, `description`, `categoryId`, `categoryName`
  - `variations[]`: `{ id, name, priceCents, currency, sku }`
  - `imageUrl`, `updatedAt`, `lastSyncedAt`, `version` (Square `updated_at` / `version`)
- `square_categories/{categoryId}` — `{ name, updatedAt }`
- `square_sync_state/global` — `{ lastFullSyncAt, lastCursor, lastStatus, lastError }`
- `media/{mediaDocId}.squareBindings` — already-existing media doc gets an optional `squareBindings: { [fieldKey]: { itemId, variationId, field: "price"|"name"|"description" } }` plus `overrides: { [fieldKey]: string }`.

**Cloud Functions (gen2, Node 20, region `us-central1`)**
- `syncSquareCatalog` (HTTPS, callable from Lovable with Firebase Auth ID token):
  - Pages `POST /v2/catalog/search` (object types `ITEM`, `ITEM_VARIATION`, `CATEGORY`) using `cursor`, batched writes (≤500 ops per batch) into `square_items` / `square_categories`.
  - Tombstones items missing from the response (`deletedAt` flag, not hard delete — keeps editor links intact).
  - Updates `square_sync_state/global`.
- `scheduledSquareSync` (Cloud Scheduler, every 30 min) — calls the same internal `runSync()` helper.
- `squareWebhook` (HTTPS, no auth, `/api/public`-equivalent path): verifies `x-square-hmacsha256-signature` against `SQUARE_WEBHOOK_SIGNATURE_KEY`, triggers a delta sync on `catalog.version.updated`.
- All write paths share one `runSync()` so manual, scheduled, and webhook syncs are identical.

**Security rules (Firestore)**
- `square_items`, `square_categories`, `square_sync_state`: `allow read: if request.auth != null;` `allow write: if false;` (only Cloud Functions write).
- `media/{id}`: existing rules + allow the owner to write `squareBindings` and `overrides` maps.

---

### 2. Lovable editor (frontend only)

**Firebase client** (`src/integrations/firebase/client.ts`)
- Initialise Firebase app with the existing public web config (already used for storage uploads).
- Use Firebase Auth (anonymous or email — match whatever the signage app already uses) so the callable / Firestore reads pass `request.auth != null`.

**Data hooks**
- `useSquareCatalog()` — Firestore `onSnapshot` over `square_items` (active only), keyed cache via TanStack Query.
- `useSquareSyncState()` — `onSnapshot` for `square_sync_state/global` to show last sync time + status.
- `triggerSquareSync()` — wraps the `syncSquareCatalog` callable.

**Editor UI** (in `src/routes/_authenticated/editor.tsx`, new right-panel tab "Square")
- Sync status header: last sync time, "Sync now" button, error pill if `lastStatus === "error"`. Always renders even if sync failed.
- Search / category filter list of items with thumbnail, name, price.
- "Insert as menu item" → adds a grouped text object (name + price text layers) and writes `squareBindings` for those layers on save.
- For the active text object, a "Bind to Square" picker (item → variation → field: price / name / description). Selecting it populates the text live.
- "Edit locally" toggle on a bound field → writes to `overrides[fieldKey]`; bound value is shown struck-through underneath as reference. Saving keeps the binding intact so future syncs do NOT clobber the override, but a one-click "Reset to Square value" clears the override.

**Resolution rule (single place, `src/lib/square-binding.ts`)**
- `resolveFieldValue(binding, override, catalog)`:
  1. If `override` present → use it.
  2. Else if `binding` resolves to a live `square_items` doc → use the bound field, formatted as currency for `price`.
  3. Else → fall back to the last cached value stored on the object so templates keep rendering when sync is down or the item was deleted.

**Failure behaviour**
- All Square reads are non-blocking — editor mounts even if Firestore is offline. Bound fields render the last cached value with a small "stale" indicator.
- Sync errors surface as a toast + the status pill, never as a thrown error in the editor.

---

### 3. Secrets the user must add (build step)

Before deploy:
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_ENVIRONMENT`
- `SQUARE_LOCATION_ID` (optional)
- `SQUARE_WEBHOOK_SIGNATURE_KEY` (only if enabling webhooks)

Added with `firebase functions:secrets:set NAME` and bound in `defineSecret(...)` in each function.

---

### 4. Deploy order

1. Add `functions/square/` + update `firebase.json` `functions` array to include a second codebase.
2. `firebase deploy --only functions:square,firestore:rules`.
3. In Square dashboard → Webhooks: point `catalog.version.updated` at the deployed `squareWebhook` URL.
4. In Cloud Scheduler: confirm `scheduledSquareSync` is enabled (auto-created by gen2 scheduled function).
5. From the editor, click "Sync now" to seed Firestore.

---

### Technical details

- Square SDK: `square@^38` (REST client, ESM). Use `client.catalogApi.searchCatalogObjects` with `include_related_objects: true` so categories come back in one call.
- BigInt prices: Square returns `amount` as a JS number/bigint in minor units — store as plain `number` (`priceCents`) in Firestore for easy comparison; never store as float.
- Currency formatting on the client only (`Intl.NumberFormat`).
- Idempotency: each sync writes `version` from Square; skip writes when local `version >=` incoming.
- Pagination: respect Square's `cursor`; cap a single run at ~5000 items, continue on next invocation via `lastCursor`.
- Webhook verification uses `crypto.timingSafeEqual` over `HMAC-SHA256(notificationUrl + body, signatureKey)` exactly as documented by Square.
- The compressor and Square functions live in the same `functions/` folder but ship as separate codebases so a Square deploy doesn't touch the media pipeline.

---

### Out of scope (will not change here)
- Square OAuth flow (using a static access token for the merchant account, as is standard for single-tenant signage installs).
- Inventory counts / orders — only catalog (items, variations, categories, prices).
- Multi-currency conversion.
