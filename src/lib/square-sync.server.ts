import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { fetchOnlineSiteCatalog } from "./square-online.server";

type SquareItem = {
  id: string;
  type: string;
  item_data?: {
    name?: string;
    description?: string;
    category_id?: string;
    variations?: Array<{
      id: string;
      item_variation_data?: {
        name?: string;
        price_money?: { amount?: number; currency?: string };
      };
    }>;
  };
};

const SQUARE_HOSTS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

export async function fetchCatalogPage(token: string, env: string, cursor?: string) {
  const host = SQUARE_HOSTS[env as keyof typeof SQUARE_HOSTS] ?? SQUARE_HOSTS.production;
  const url = new URL(`${host}/v2/catalog/list`);
  url.searchParams.set("types", "ITEM");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": "2024-10-17",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Square API error ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { objects?: SquareItem[]; cursor?: string };
  return { items: json.objects ?? [], cursor: json.cursor };
}

export async function fetchAllCatalog(token: string, env: string) {
  const host = SQUARE_HOSTS[env as keyof typeof SQUARE_HOSTS] ?? SQUARE_HOSTS.production;
  const items: SquareItem[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${host}/v2/catalog/list`);
    url.searchParams.set("types", "ITEM");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Square-Version": "2024-10-17",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Square API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { objects?: SquareItem[]; cursor?: string };
    if (json.objects) items.push(...json.objects);
    cursor = json.cursor;
  } while (cursor);
  return items;
}

export function flattenItem(item: SquareItem) {
  const variations = item.item_data?.variations ?? [];
  const baseName = item.item_data?.name ?? null;
  const description = item.item_data?.description ?? null;
  const category = item.item_data?.category_id ?? null;
  // 0 or 1 variation: keep one row keyed by item id (preserves existing bindings).
  if (variations.length <= 1) {
    const v = variations[0]?.item_variation_data;
    return [{
      square_item_id: item.id,
      name: baseName,
      description,
      category,
      price_cents: v?.price_money?.amount ?? null,
      currency: v?.price_money?.currency ?? "USD",
      raw: item as unknown as Json,
    }];
  }
  // Multiple variations: emit one row per variation with synthetic id `${itemId}:${variationId}`.
  return variations.map((variation) => {
    const v = variation.item_variation_data;
    const variationName = v?.name?.trim() || "Default";
    return {
      square_item_id: `${item.id}:${variation.id}`,
      name: baseName ? `${baseName} — ${variationName}` : variationName,
      description,
      category,
      price_cents: v?.price_money?.amount ?? null,
      currency: v?.price_money?.currency ?? "USD",
      raw: { ...(item as unknown as Record<string, unknown>), _variation_id: variation.id } as unknown as Json,
    };
  });
}

function uniqueBySquareItemId<T extends { square_item_id: string }>(rows: T[]) {
  return Array.from(new Map(rows.map((row) => [row.square_item_id, row])).values());
}

export type ConnectionSource = {
  source: string;
  access_token: string | null;
  environment: string;
  site_url: string | null;
};

/** Resolve a single page of items for either source. Online-site source returns everything in one page. */
type FlatRow = ReturnType<typeof flattenItem>[number];

export async function fetchSourcePage(conn: ConnectionSource, cursor?: string): Promise<{ items: FlatRow[]; cursor: string | undefined }> {
  if (conn.source === "online_site") {
    if (!conn.site_url) throw new Error("Square Online site URL is not set");
    if (cursor) return { items: [], cursor: undefined };
    const items = await fetchOnlineSiteCatalog(conn.site_url);
    return { items, cursor: undefined };
  }
  if (!conn.access_token) throw new Error("Square access token is not set");
  const page = await fetchCatalogPage(conn.access_token, conn.environment, cursor);
  return { items: page.items.flatMap(flattenItem), cursor: page.cursor };
}

/** Run sync + stale detection for a single user, using the admin client. */
export async function syncUserCatalog(userId: string, conn: ConnectionSource) {
  const collected: FlatRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchSourcePage(conn, cursor);
    collected.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  const flat = uniqueBySquareItemId(collected);

  await supabaseAdmin.from("square_items_cache").delete().eq("user_id", userId);
  if (flat.length) {
    const rows = flat.map((f) => ({ ...f, user_id: userId }));
    const { error } = await supabaseAdmin
      .from("square_items_cache")
      .upsert(rows, { onConflict: "user_id,square_item_id" });
    if (error) throw new Error(error.message);
  }

  await supabaseAdmin
    .from("square_connections")
    .update({ last_sync_at: new Date().toISOString() })
    .eq("user_id", userId);

  const { staleCount, updatedCount } = await recomputeStaleTemplates(userId);
  return { itemCount: flat.length, staleCount, updatedCount };
}

/** Compare each template's last price snapshot against current cache and flip is_stale on changes. */
export async function recomputeStaleTemplates(userId: string) {
  const { data: items } = await supabaseAdmin
    .from("square_items_cache")
    .select("square_item_id, name, description, price_cents, currency")
    .eq("user_id", userId);
  const priceMap: Record<string, number | null> = {};
  const itemMap = new Map<string, { name: string | null; description: string | null; price_cents: number | null; currency: string | null }>();
  for (const it of items ?? []) {
    priceMap[it.square_item_id] = it.price_cents;
    itemMap.set(it.square_item_id, {
      name: it.name,
      description: it.description,
      price_cents: it.price_cents,
      currency: it.currency,
    });
  }

  const { data: templates } = await supabaseAdmin
    .from("templates")
    .select("id, square_bindings, last_price_snapshot, is_stale, canvas_json")
    .eq("user_id", userId);

  let staleCount = 0;
  let updatedCount = 0;
  for (const t of templates ?? []) {
    const bindings = (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
    const snapshot = (t.last_price_snapshot as Record<string, number | null> | null) ?? {};

    // 1. Auto-apply per-text-layer bindings inside canvas_json (this is what users actually see)
    const { json: nextCanvas, changed } = applyBoundPricesToCanvas(t.canvas_json, itemMap);

    // 2. Determine if any template-level bound item's price changed since last snapshot
    let priceChanged = false;
    for (const b of bindings) {
      const current = priceMap[b.square_item_id] ?? null;
      if (snapshot[b.square_item_id] !== current) priceChanged = true;
    }

    if (changed) {
      // Refresh snapshot to current prices and clear stale flag (canvas now matches catalog)
      const nextSnapshot: Record<string, number | null> = { ...snapshot };
      for (const b of bindings) nextSnapshot[b.square_item_id] = priceMap[b.square_item_id] ?? null;
      await supabaseAdmin
        .from("templates")
        .update({ canvas_json: nextCanvas as Json, last_price_snapshot: nextSnapshot, is_stale: false })
        .eq("id", t.id);
      updatedCount++;
    } else if (priceChanged && !t.is_stale) {
      // Template-level binding price changed but no auto-updatable text layers — flag for manual review
      staleCount++;
      await supabaseAdmin.from("templates").update({ is_stale: true }).eq("id", t.id);
    }
  }
  return { staleCount, updatedCount, total: staleCount + updatedCount };
}

type CacheItem = { name: string | null; description: string | null; price_cents: number | null; currency: string | null };

function formatBoundValue(item: CacheItem | undefined, field: string): string {
  if (!item) return "";
  if (field === "name") return item.name ?? "";
  if (field === "description") return item.description ?? "";
  if (item.price_cents == null) return "";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: item.currency || "USD" }).format(item.price_cents / 100);
  } catch {
    return `$${(item.price_cents / 100).toFixed(2)}`;
  }
}

/** Walk Fabric canvas JSON and rewrite text layers with `squareBinding` to current values. */
function applyBoundPricesToCanvas(canvasJson: unknown, itemMap: Map<string, CacheItem>): { json: unknown; changed: boolean } {
  if (!canvasJson || typeof canvasJson !== "object") return { json: canvasJson, changed: false };
  const next = JSON.parse(JSON.stringify(canvasJson)) as Record<string, unknown>;
  let changed = false;

  const visit = (obj: Record<string, unknown>) => {
    const binding = obj.squareBinding as { itemId?: string; field?: string } | undefined;
    if (binding?.itemId && binding.field) {
      const formatted = formatBoundValue(itemMap.get(binding.itemId), binding.field);
      if (formatted && obj.text !== formatted) {
        obj.text = formatted;
        changed = true;
      }
    }
    const kids = (obj.objects ?? (obj as Record<string, unknown>)._objects) as unknown;
    if (Array.isArray(kids)) for (const child of kids) if (child && typeof child === "object") visit(child as Record<string, unknown>);
  };

  const objs = (next.objects ?? []) as unknown;
  if (Array.isArray(objs)) for (const o of objs) if (o && typeof o === "object") visit(o as Record<string, unknown>);
  return { json: next, changed };
}