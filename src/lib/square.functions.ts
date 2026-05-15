import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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

async function fetchAllCatalog(token: string, env: string) {
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

function flattenItem(item: SquareItem) {
  const v = item.item_data?.variations?.[0]?.item_variation_data;
  return {
    square_item_id: item.id,
    name: item.item_data?.name ?? null,
    description: item.item_data?.description ?? null,
    category: item.item_data?.category_id ?? null,
    price_cents: v?.price_money?.amount ?? null,
    currency: v?.price_money?.currency ?? "USD",
    raw: item as unknown as Record<string, unknown>,
  };
}

export const syncSquareCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: conn, error: connErr } = await supabase
      .from("square_connections")
      .select("access_token, environment")
      .maybeSingle();
    if (connErr) throw new Error(connErr.message);
    if (!conn) throw new Error("Square is not connected. Add a token in Settings first.");

    const items = await fetchAllCatalog(conn.access_token, conn.environment);
    const flat = items.map(flattenItem);

    // Build a price map: square_item_id -> price_cents
    const priceMap: Record<string, number | null> = {};
    for (const f of flat) priceMap[f.square_item_id] = f.price_cents;

    // Upsert cache
    if (flat.length) {
      const rows = flat.map((f) => ({ ...f, user_id: userId }));
      // Wipe + insert is simplest given no unique constraint defined here
      await supabase.from("square_items_cache").delete().eq("user_id", userId);
      const { error: insErr } = await supabase.from("square_items_cache").insert(rows);
      if (insErr) throw new Error(insErr.message);
    }

    await supabase
      .from("square_connections")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("user_id", userId);

    // Stale detection: compare each template's last_price_snapshot
    const { data: templates } = await supabase
      .from("templates")
      .select("id, square_bindings, last_price_snapshot, is_stale");

    let staleCount = 0;
    for (const t of templates ?? []) {
      const bindings = (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
      if (!bindings.length) continue;
      const snapshot = (t.last_price_snapshot as Record<string, number | null> | null) ?? {};
      let stale = false;
      const newSnap: Record<string, number | null> = {};
      for (const b of bindings) {
        const current = priceMap[b.square_item_id] ?? null;
        newSnap[b.square_item_id] = current;
        if (snapshot[b.square_item_id] !== current) stale = true;
      }
      if (stale && !t.is_stale) {
        staleCount++;
        await supabase.from("templates").update({ is_stale: true }).eq("id", t.id);
      }
    }

    return { itemCount: flat.length, staleCount };
  });

export const listSquareItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("square_items_cache")
      .select("square_item_id, name, price_cents, currency, category, synced_at")
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return { items: data ?? [] };
  });

export const markTemplateFresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ templateId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: t, error } = await supabase
      .from("templates")
      .select("square_bindings")
      .eq("id", data.templateId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!t) throw new Error("Template not found");

    const bindings = (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
    const ids = bindings.map((b) => b.square_item_id);
    const snap: Record<string, number | null> = {};
    if (ids.length) {
      const { data: items } = await supabase
        .from("square_items_cache")
        .select("square_item_id, price_cents")
        .in("square_item_id", ids);
      for (const it of items ?? []) snap[it.square_item_id] = it.price_cents;
    }

    const { error: upErr } = await supabase
      .from("templates")
      .update({ is_stale: false, last_price_snapshot: snap })
      .eq("id", data.templateId);
    if (upErr) throw new Error(upErr.message);
    return { ok: true, snapshot: snap };
  });

export const listTemplatesWithStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("templates")
      .select("id, name, preset, is_stale, updated_at, square_bindings")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { templates: data ?? [] };
  });