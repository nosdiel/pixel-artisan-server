import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { syncUserCatalog, fetchSourcePage, recomputeStaleTemplates } from "./square-sync.server";

function uniqueBySquareItemId<T extends { square_item_id: string }>(rows: T[]) {
  return Array.from(new Map(rows.map((row) => [row.square_item_id, row])).values());
}

export const syncSquareCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: conn, error: connErr } = await supabase
      .from("square_connections")
      .select("source, access_token, environment, site_url")
      .maybeSingle();
    if (connErr) throw new Error(connErr.message);
    if (!conn) throw new Error("Square is not connected. Add a token in Settings first.");
    return syncUserCatalog(userId, conn);
  });

/** Start a background sync job: cancel any running job, wipe cache, return new job id. */
export const startSquareSyncJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: conn } = await supabase
      .from("square_connections")
      .select("source, access_token, environment, site_url")
      .maybeSingle();
    if (!conn) throw new Error("Square is not connected. Configure it in Settings first.");

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
      .select("source, access_token, environment, site_url")
      .maybeSingle();
    if (!conn) throw new Error("Square connection missing");

    try {
      const { items, cursor } = await fetchSourcePage(conn, job.cursor ?? undefined);
      const flat = items.map((it) => ({ ...it, user_id: userId }));
      const uniqueRows = uniqueBySquareItemId(flat);
      if (uniqueRows.length) {
        const { error: insErr } = await supabase
          .from("square_items_cache")
          .upsert(uniqueRows, { onConflict: "user_id,square_item_id" });
        if (insErr) throw new Error(insErr.message);
      }
      const processed = job.processed_items + flat.length;
      const done = !cursor;

      if (done) {
        const { staleCount, updatedCount } = await recomputeStaleTemplates(userId);
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
            stale_templates: staleCount + updatedCount,
            finished_at: new Date().toISOString(),
          })
          .eq("id", job.id);
        return { status: "succeeded" as const, processed, staleCount, updatedCount, done: true };
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
      .select("source, environment, site_url, last_sync_at, auto_sync_enabled, merchant_id")
      .maybeSingle();
    return { connection: data };
  });

export const saveSquareConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.discriminatedUnion("source", [
      z.object({
        source: z.literal("api"),
        environment: z.enum(["production", "sandbox"]),
        access_token: z.string().min(4).max(2000),
      }),
      z.object({
        source: z.literal("online_site"),
        site_url: z.string().url().max(500),
      }),
    ]).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.source === "online_site") {
      // Lightweight reachability check only — many Square Online pages render
      // products via JS, so JSON-LD may be absent in the initial HTML. The
      // background sync job surfaces real fetch/parse errors later.
      try {
        const url = /^https?:\/\//i.test(data.site_url) ? data.site_url : `https://${data.site_url}`;
        const res = await fetch(url, { method: "GET", redirect: "follow" });
        if (!res.ok) throw new Error(`Site returned ${res.status}`);
      } catch (e) {
        throw new Error(`Could not reach site: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const row = (
      data.source === "api"
        ? {
            user_id: context.userId,
            source: "api",
            access_token: data.access_token,
            environment: data.environment,
            site_url: null,
          }
        : {
            user_id: context.userId,
            source: "online_site",
            access_token: null,
            environment: "production",
            site_url: data.site_url,
          }
    ) as never;
    const { error } = await context.supabase.from("square_connections").upsert(row);
    if (error) throw new Error(error.message);
    return { ok: true };
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

export const setTemplateBindings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      templateId: z.string().uuid(),
      squareItemIds: z.array(z.string().min(1).max(200)).max(500),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const ids = Array.from(new Set(data.squareItemIds));
    const snap: Record<string, number | null> = {};
    if (ids.length) {
      const { data: items, error: itErr } = await supabase
        .from("square_items_cache")
        .select("square_item_id, price_cents")
        .in("square_item_id", ids);
      if (itErr) throw new Error(itErr.message);
      for (const it of items ?? []) snap[it.square_item_id] = it.price_cents;
    }
    const bindings = ids.map((square_item_id) => ({ square_item_id }));
    const { error } = await supabase
      .from("templates")
      .update({ square_bindings: bindings, last_price_snapshot: snap, is_stale: false })
      .eq("id", data.templateId);
    if (error) throw new Error(error.message);
    return { ok: true, count: ids.length };
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ templateId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("templates")
      .delete()
      .eq("id", data.templateId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });