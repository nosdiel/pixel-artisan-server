import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

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
  const v = item.item_data?.variations?.[0]?.item_variation_data;
  return {
    square_item_id: item.id,
    name: item.item_data?.name ?? null,
    description: item.item_data?.description ?? null,
    category: item.item_data?.category_id ?? null,
    price_cents: v?.price_money?.amount ?? null,
    currency: v?.price_money?.currency ?? "USD",
    raw: item as unknown as Json,
  };
}

/** Run sync + stale detection for a single user, using the admin client. */
export async function syncUserCatalog(userId: string, token: string, env: string) {
  const items = await fetchAllCatalog(token, env);
  const flat = items.map(flattenItem);

  const priceMap: Record<string, number | null> = {};
  for (const f of flat) priceMap[f.square_item_id] = f.price_cents;

  await supabaseAdmin.from("square_items_cache").delete().eq("user_id", userId);
  if (flat.length) {
    const rows = flat.map((f) => ({ ...f, user_id: userId }));
    const { error } = await supabaseAdmin.from("square_items_cache").insert(rows);
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