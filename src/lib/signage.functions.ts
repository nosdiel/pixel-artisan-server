import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  checkRendererHealth,
  prepareTemplateForBrowserRender,
  uploadRenderedPng,
  uploadRenderedVideo,
} from "./signage.server";

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
    const normalizedToken = data.renderer_auth_token
      ? data.renderer_auth_token.trim().replace(/^Bearer\s+/i, "") || null
      : null;
    const { error } = await context.supabase
      .from("signage_settings")
      .upsert({
        user_id: context.userId,
        company_id: data.company_id,
        renderer_url: data.renderer_url,
        renderer_auth_token: normalizedToken,
        auto_publish_enabled: data.auto_publish_enabled,
      });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testRenderer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      renderer_url: z.string().url().max(500).optional(),
      renderer_auth_token: z.string().max(500).optional().nullable(),
    }).optional().parse(d),
  )
  .handler(async ({ data, context }) => {
    let rendererUrl = data?.renderer_url?.trim() ?? "";
    let rendererAuthToken = data?.renderer_auth_token ?? null;

    if (!rendererUrl) {
      const { data: s } = await context.supabase
        .from("signage_settings")
        .select("renderer_url, renderer_auth_token")
        .maybeSingle();
      rendererUrl = s?.renderer_url?.trim() ?? "";
      rendererAuthToken = s?.renderer_auth_token ?? null;
    }

    if (!rendererUrl) throw new Error("Renderer URL is not set");
    const rawToken = rendererAuthToken?.trim().replace(/^Bearer\s+/i, "") ?? "";
    try {
      return await checkRendererHealth(rendererUrl, rawToken || null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const url = rendererUrl.replace(/\/+$/, "") + "/health";
      return { ok: false, status: 0, statusText: "Request failed", url, body: message };
    }
  });

/**
 * Step 1 of publish: returns canvasJson (with images inlined as base64) plus
 * the dimensions / company id the browser needs to render the PNG.
 */
export const prepareTemplatePublish = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ templateId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    return prepareTemplateForBrowserRender(context.userId, data.templateId);
  });

/**
 * Step 2 of publish: takes the browser-rendered PNG (base64) and forwards
 * it to the upload service.
 */
export const publishRenderedTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      templateId: z.string().uuid(),
      pngBase64: z.string().min(64).max(60 * 1024 * 1024),
      width: z.number().int().positive().max(20000).optional(),
      height: z.number().int().positive().max(20000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    return uploadRenderedPng(context.userId, data);
  });

/**
 * Step 2 (video variant): takes a browser-recorded MP4 or WebM (base64) and
 * forwards it to the upload service.
 */
export const publishRenderedVideoTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      templateId: z.string().uuid(),
      videoBase64: z.string().min(64).max(150 * 1024 * 1024),
      mimeType: z.enum(["video/mp4", "video/webm"]),
      width: z.number().int().positive().max(20000).optional(),
      height: z.number().int().positive().max(20000).optional(),
      durationMs: z.number().int().positive().max(120000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    return uploadRenderedVideo(context.userId, data);
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
