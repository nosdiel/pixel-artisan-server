import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { callRenderer, publishTemplateToRenderer } from "./signage.server";

export const getSignageSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("signage_settings")
      .select("company_id, renderer_url, renderer_auth_token, auto_publish_enabled, updated_at")
      .maybeSingle();
    return { settings: data };
  });

export const saveSignageSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      company_id: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_\-]+$/, "Company ID can contain only letters, numbers, dashes and underscores"),
      renderer_url: z.string().url().max(500),
      renderer_auth_token: z.string().max(500).optional().nullable(),
      auto_publish_enabled: z.boolean(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("signage_settings")
      .upsert({
        user_id: context.userId,
        company_id: data.company_id,
        renderer_url: data.renderer_url,
        renderer_auth_token: data.renderer_auth_token || null,
        auto_publish_enabled: data.auto_publish_enabled,
      });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testRenderer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: s } = await context.supabase
      .from("signage_settings")
      .select("renderer_url, renderer_auth_token, company_id")
      .maybeSingle();
    if (!s?.renderer_url) throw new Error("Renderer URL is not set");
    const url = s.renderer_url.replace(/\/+$/, "") + "/health";
    const headers: Record<string, string> = {};
    if (s.renderer_auth_token) headers["Authorization"] = `Bearer ${s.renderer_auth_token}`;
    const res = await fetch(url, { headers });
    const body = await res.text();
    if (!res.ok) throw new Error(`Renderer health check failed (${res.status}): ${body.slice(0, 200)}`);
    return { ok: true, body: body.slice(0, 200) };
  });

export const publishTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ templateId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    return publishTemplateToRenderer(context.userId, data.templateId);
  });

export const listTemplatesWithPublishStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("templates")
      .select("id, last_published_at, last_published_url, last_publish_status, last_publish_error")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { rows: data ?? [] };
  });

// Re-export so unused-import lint doesn't strip helper
export { callRenderer };