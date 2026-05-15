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

  const priceMap: Record<string, number | null> = {};
  for (const f of flat) priceMap[f.square_item_id] = f.price_cents;

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

  const { data: templates } = await supabaseAdmin
    .from("templates")
    .select("id, square_bindings, last_price_snapshot, is_stale")
    .eq("user_id", userId);

  let staleCount = 0;
  for (const t of templates ?? []) {
    const bindings = (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
    if (!bindings.length) continue;
    const snapshot = (t.last_price_snapshot as Record<string, number | null> | null) ?? {};
    let stale = false;
    for (const b of bindings) {
      const current = priceMap[b.square_item_id] ?? null;
      if (snapshot[b.square_item_id] !== current) stale = true;
    }
    if (stale && !t.is_stale) {
      staleCount++;
      await supabaseAdmin.from("templates").update({ is_stale: true }).eq("id", t.id);
    }
  }

  return { itemCount: flat.length, staleCount };
}

/** Compare each template's last price snapshot against current cache and flip is_stale on changes. */
export async function recomputeStaleTemplates(userId: string) {
  const { data: items } = await supabaseAdmin
    .from("square_items_cache")
    .select("square_item_id, price_cents")
    .eq("user_id", userId);
  const priceMap: Record<string, number | null> = {};
  for (const it of items ?? []) priceMap[it.square_item_id] = it.price_cents;

  const { data: templates } = await supabaseAdmin
    .from("templates")
    .select("id, square_bindings, last_price_snapshot, is_stale")
    .eq("user_id", userId);

  let staleCount = 0;
  for (const t of templates ?? []) {
    const bindings = (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
    if (!bindings.length) continue;
    const snapshot = (t.last_price_snapshot as Record<string, number | null> | null) ?? {};
    let stale = false;
    for (const b of bindings) {
      const current = priceMap[b.square_item_id] ?? null;
      if (snapshot[b.square_item_id] !== current) stale = true;
    }
    if (stale && !t.is_stale) {
      staleCount++;
      await supabaseAdmin.from("templates").update({ is_stale: true }).eq("id", t.id);
    }
  }
  return staleCount;
}