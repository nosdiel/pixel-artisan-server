import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { syncUserCatalog } from "./square-sync.server";

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
    return syncUserCatalog(userId, conn.access_token, conn.environment);
  });

export const setAutoSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("square_connections")
      .update({ auto_sync_enabled: data.enabled })
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getSquareConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("square_connections")
      .select("environment, last_sync_at, auto_sync_enabled, merchant_id")
      .maybeSingle();
    return { connection: data };
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