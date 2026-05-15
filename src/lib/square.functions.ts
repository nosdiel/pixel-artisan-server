import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { syncUserCatalog, fetchCatalogPage, flattenItem, recomputeStaleTemplates } from "./square-sync.server";

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

/** Start a background sync job: cancel any running job, wipe cache, return new job id. */
export const startSquareSyncJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: conn } = await supabase
      .from("square_connections")
      .select("access_token, environment")
      .maybeSingle();
    if (!conn) throw new Error("Square is not connected. Add a token in Settings first.");

    // Mark any prior running job for this user as cancelled
    await supabase
      .from("square_sync_jobs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("status", "running");

    // Fresh sync wipes cache so progressive inserts replace the old snapshot
    await supabase.from("square_items_cache").delete().eq("user_id", userId);

    const { data: job, error } = await supabase
      .from("square_sync_jobs")
      .insert({ user_id: userId, status: "running" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { jobId: job.id };
  });

/** Process the next page of a running sync job. Call repeatedly from the client until done. */
export const stepSquareSyncJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ jobId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: job, error: jobErr } = await supabase
      .from("square_sync_jobs")
      .select("id, status, cursor, processed_items")
      .eq("id", data.jobId)
      .maybeSingle();
    if (jobErr) throw new Error(jobErr.message);
    if (!job) throw new Error("Sync job not found");
    if (job.status !== "running") return { status: job.status, processed: job.processed_items, done: true };

    const { data: conn } = await supabase
      .from("square_connections")
      .select("access_token, environment")
      .maybeSingle();
    if (!conn) throw new Error("Square connection missing");

    try {
      const { items, cursor } = await fetchCatalogPage(conn.access_token, conn.environment, job.cursor ?? undefined);
      const flat = items.map((it) => ({ ...flattenItem(it), user_id: userId }));
      if (flat.length) {
        const { error: insErr } = await supabase.from("square_items_cache").insert(flat);
        if (insErr) throw new Error(insErr.message);
      }
      const processed = job.processed_items + flat.length;
      const done = !cursor;

      if (done) {
        const staleCount = await recomputeStaleTemplates(userId);
        await supabase
          .from("square_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("user_id", userId);
        await supabase
          .from("square_sync_jobs")
          .update({
            status: "succeeded",
            cursor: null,
            processed_items: processed,
            stale_templates: staleCount,
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        return { status: "succeeded" as const, processed, staleCount, done: true };
      }

      await supabase
        .from("square_sync_jobs")
        .update({ cursor, processed_items: processed })
        .eq("id", job.id);
      return { status: "running" as const, processed, done: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await supabase
        .from("square_sync_jobs")
        .update({ status: "failed", error: message, finished_at: new Date().toISOString() })
        .eq("id", job.id);
      throw new Error(message);
    }
  });

export const getSquareSyncJob = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ jobId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: job, error } = await context.supabase
      .from("square_sync_jobs")
      .select("id, status, processed_items, stale_templates, error, started_at, finished_at")
      .eq("id", data.jobId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { job };
  });

export const getLatestSquareSyncJob = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("square_sync_jobs")
      .select("id, status, processed_items, stale_templates, error, started_at, finished_at")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { job: data };
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