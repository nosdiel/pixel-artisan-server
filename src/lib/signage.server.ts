import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type RendererHealthResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  body: string;
};

const PRESET_SIZES: Record<string, { w: number; h: number }> = {
  "1920x1080": { w: 1920, h: 1080 },
  "3840x2160": { w: 3840, h: 2160 },
  "1080x1920": { w: 1080, h: 1920 },
  "2160x3840": { w: 2160, h: 3840 },
  "1280x720": { w: 1280, h: 720 },
  "1080x1080": { w: 1080, h: 1080 },
};

const REQUIRED_RENDERER_VERSION = "2026-05-20-video-ffmpeg-mp4";

function rendererUpgradeMessage(actualVersion?: string | null) {
  const actual = actualVersion ? ` Current /health rendererVersion is "${actualVersion}".` : "";
  return `Renderer service is outdated: it does not support browser-side PNG upload at /upload.${actual} Redeploy renderer-service, then confirm /health reports rendererVersion "${REQUIRED_RENDERER_VERSION}".`;
}

async function assertRendererSupportsUpload(rendererUrl: string, rendererAuthToken: string | null) {
  let health: RendererHealthResponse;
  try {
    health = await checkRendererHealth(rendererUrl, rendererAuthToken);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not reach renderer /health before upload: ${message}`);
  }

  if (!health.ok) {
    throw new Error(
      `Renderer /health failed (${health.status} ${health.statusText}): ${health.body.slice(0, 300)}`,
    );
  }

  let parsed: { rendererVersion?: string };
  try {
    parsed = JSON.parse(health.body) as { rendererVersion?: string };
  } catch {
    throw new Error(
      `Renderer /health returned non-JSON, so upload support cannot be verified: ${health.body.slice(0, 300)}`,
    );
  }

  if (parsed.rendererVersion !== REQUIRED_RENDERER_VERSION) {
    throw new Error(rendererUpgradeMessage(parsed.rendererVersion ?? null));
  }
}

async function warnIfRendererHealthCheckFails(
  rendererUrl: string,
  rendererAuthToken: string | null,
) {
  try {
    await assertRendererSupportsUpload(rendererUrl, rendererAuthToken);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[renderer health preflight skipped]", message);
  }
}

function extractImageStoragePath(src: string) {
  try {
    const url = new URL(src);
    const markers = ["/storage/v1/object/sign/images/", "/storage/v1/object/public/images/"];
    const marker = markers.find((m) => url.pathname.includes(m));
    if (!marker) return null;
    return decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  } catch {
    return null;
  }
}

function mimeForStoragePath(path: string) {
  const clean = path.toLowerCase().split("?")[0];
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
}

async function refreshCanvasMediaUrls(canvasJson: unknown) {
  type FabricNode = {
    type?: string;
    src?: string;
    crossOrigin?: string;
    imageStoragePath?: string;
    videoStoragePath?: string;
    videoSrc?: string;
    width?: number;
    height?: number;
    scaleX?: number;
    scaleY?: number;
    left?: number;
    top?: number;
    objects?: FabricNode[];
    _objects?: FabricNode[];
    clipPath?: FabricNode;
    backgroundImage?: FabricNode;
  };
  const json = JSON.parse(JSON.stringify(canvasJson)) as FabricNode;
  let refreshedImages = 0;
  let inlinedImageBytes = 0;
  let refreshedVideos = 0;
  const refreshObject = async (obj: FabricNode | null | undefined): Promise<void> => {
    if (!obj || typeof obj !== "object") return;
    // Refresh video signed URLs in place (we can't inline videos as base64
    // — they're too large — so keep them as fresh signed URLs).
    const videoPath = typeof obj.videoStoragePath === "string" ? obj.videoStoragePath : null;
    if (videoPath) {
      const { data, error } = await supabaseAdmin.storage
        .from("images")
        .createSignedUrl(videoPath, 3600);
      if (error) throw new Error(`Could not refresh video URL for render: ${error.message}`);
      if (data?.signedUrl) {
        obj.videoSrc = data.signedUrl;
        refreshedVideos++;
      }
    }
    const path = videoPath
      ? null
      : typeof obj.imageStoragePath === "string"
        ? obj.imageStoragePath
        : typeof obj.src === "string"
          ? extractImageStoragePath(obj.src)
          : null;
    if (path) {
      const { data, error } = await supabaseAdmin.storage
        .from("images")
        .createSignedUrl(path, 3600);
      if (error) throw new Error(`Could not refresh image URL for render: ${error.message}`);
      if (data?.signedUrl) {
        const imageRes = await fetch(data.signedUrl, { redirect: "follow" });
        if (!imageRes.ok) throw new Error(`Could not load image for render (${imageRes.status})`);
        const contentType = imageRes.headers.get("content-type")?.startsWith("image/")
          ? imageRes.headers.get("content-type")!
          : mimeForStoragePath(path);
        const bytes = Buffer.from(await imageRes.arrayBuffer());
        obj.src = `data:${contentType};base64,${bytes.toString("base64")}`;
        obj.crossOrigin = "anonymous";
        obj.imageStoragePath = path;
        refreshedImages++;
        inlinedImageBytes += bytes.length;
      }
    }
    await Promise.all((obj.objects ?? obj._objects ?? []).map(refreshObject));
    if (obj.clipPath) await refreshObject(obj.clipPath);
  };
  await Promise.all((json.objects ?? []).map(refreshObject));
  if (json.backgroundImage) await refreshObject(json.backgroundImage);
  return { canvasJson: json, refreshedImages, inlinedImageBytes, refreshedVideos };
}

/**
 * Some saved templates have an Image object stored with stale scaleX/scaleY
 * (e.g. the editor scaled a thumbnail to fit the canvas, then the src was
 * swapped for a full-res copy without resetting the scale). Result: the image
 * renders at 2x+ the canvas size and the canvas only shows the cropped center.
 *
 * For each Image, compare the displayed bounds against the canvas. If the
 * image's natural size already fits the canvas (within 1px) AND the stored
 * scale would blow it up beyond the canvas, force scale=1 at (0, 0). This
 * leaves intentionally-cropped images alone but fixes the common bug where
 * the base image overflows the canvas.
 */
function normalizeOversizedBaseImages(
  canvasJson: Record<string, unknown>,
  canvasW: number,
  canvasH: number,
) {
  let fixed = 0;
  const visit = (obj: Record<string, unknown> | null | undefined) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.type === "Image" || obj.type === "image") {
      const naturalW = Number(obj.width) || 0;
      const naturalH = Number(obj.height) || 0;
      const sx = Number(obj.scaleX) || 1;
      const sy = Number(obj.scaleY) || 1;
      const displayedW = naturalW * sx;
      const displayedH = naturalH * sy;
      const naturalFitsCanvas =
        Math.abs(naturalW - canvasW) <= 1 && Math.abs(naturalH - canvasH) <= 1;
      const overflowsCanvas = displayedW > canvasW * 1.05 || displayedH > canvasH * 1.05;
      if (naturalFitsCanvas && overflowsCanvas) {
        obj.scaleX = 1;
        obj.scaleY = 1;
        obj.left = 0;
        obj.top = 0;
        fixed++;
      }
    }
    const children = (obj.objects ?? obj._objects ?? []) as Record<string, unknown>[];
    for (const child of children) visit(child);
    if (obj.clipPath) visit(obj.clipPath as Record<string, unknown>);
  };
  for (const o of (canvasJson.objects ?? []) as Record<string, unknown>[]) visit(o);
  if (canvasJson.backgroundImage) visit(canvasJson.backgroundImage as Record<string, unknown>);
  return fixed;
}

export async function checkRendererHealth(
  rendererUrl: string,
  rendererAuthToken: string | null,
): Promise<RendererHealthResponse> {
  const url = rendererUrl.replace(/\/+$/, "") + "/health";
  const rawToken = rendererAuthToken?.trim().replace(/^Bearer\s+/i, "") ?? "";
  const headers: Record<string, string> = { Accept: "application/json, text/plain, */*" };
  if (rawToken) headers.Authorization = `Bearer ${rawToken}`;

  const res = await fetch(url, { method: "GET", headers, redirect: "follow" });
  const body = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    url,
    body: body.slice(0, 2000),
  };
}

async function getRendererSettings(userId: string) {
  const { data: settings } = await supabaseAdmin
    .from("signage_settings")
    .select("company_id, renderer_url, renderer_auth_token")
    .eq("user_id", userId)
    .maybeSingle();
  if (!settings?.renderer_url)
    throw new Error("Renderer URL is not configured. Add it in Settings → Signage publishing.");
  if (!settings.company_id)
    throw new Error("Company ID is not configured. Add it in Settings → Signage publishing.");
  return settings;
}

/**
 * Step 1 of the publishing flow: load the template, refresh / inline image
 * URLs, and return the payload that the browser will use to render the
 * Fabric canvas to a PNG.
 */
export async function prepareTemplateForBrowserRender(userId: string, templateId: string) {
  const settings = await getRendererSettings(userId);

  const { data: tpl, error: tplErr } = await supabaseAdmin
    .from("templates")
    .select("id, name, preset, width, height, canvas_json, square_bindings")
    .eq("id", templateId)
    .eq("user_id", userId)
    .maybeSingle();
  if (tplErr) throw new Error(tplErr.message);
  if (!tpl) throw new Error("Template not found");

  const presetSize = typeof tpl.preset === "string" ? PRESET_SIZES[tpl.preset] : undefined;
  const renderWidth = presetSize?.w ?? tpl.width;
  const renderHeight = presetSize?.h ?? tpl.height;

  const originalCanvasJson = tpl.canvas_json as { objects?: unknown[] } | null;
  const objectCount = Array.isArray(originalCanvasJson?.objects)
    ? originalCanvasJson!.objects!.length
    : 0;
  if (!originalCanvasJson || objectCount === 0) {
    await supabaseAdmin
      .from("templates")
      .update({
        last_published_at: new Date().toISOString(),
        last_publish_status: "error",
        last_publish_error: "Template has no objects.",
      })
      .eq("id", tpl.id);
    throw new Error("Template has no objects.");
  }

  const { canvasJson, refreshedImages, inlinedImageBytes, refreshedVideos } =
    await refreshCanvasMediaUrls(originalCanvasJson);
  const normalizedImages = normalizeOversizedBaseImages(canvasJson, renderWidth, renderHeight);
  console.log("[prepareTemplate]", {
    templateId: tpl.id,
    name: tpl.name,
    width: renderWidth,
    height: renderHeight,
    objectCount,
    refreshedImages,
    inlinedImageBytes,
    refreshedVideos,
    normalizedImages,
  });

  return {
    templateId: tpl.id,
    name: tpl.name,
    companyId: settings.company_id,
    width: renderWidth,
    height: renderHeight,
    canvasJson,
  };
}

/**
 * Step 2 of the publishing flow: forward the browser-rendered PNG to the
 * upload service, which writes it to Firebase Storage + Firestore.
 */
export async function uploadRenderedPng(
  userId: string,
  args: { templateId: string; pngBase64: string; width?: number; height?: number },
) {
  const settings = await getRendererSettings(userId);

  const { data: tpl, error: tplErr } = await supabaseAdmin
    .from("templates")
    .select("id, name")
    .eq("id", args.templateId)
    .eq("user_id", userId)
    .maybeSingle();
  if (tplErr) throw new Error(tplErr.message);
  if (!tpl) throw new Error("Template not found");

  const url = settings.renderer_url!.replace(/\/+$/, "") + "/upload";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const rawToken = settings.renderer_auth_token?.trim().replace(/^Bearer\s+/i, "") ?? "";
  if (rawToken) headers.Authorization = `Bearer ${rawToken}`;

  console.log("[uploadRenderedPng]", {
    templateId: tpl.id,
    name: tpl.name,
    width: args.width,
    height: args.height,
    pngBytesApprox: Math.floor((args.pngBase64?.length ?? 0) * 0.75),
  });

  try {
    await warnIfRendererHealthCheckFails(settings.renderer_url!, settings.renderer_auth_token);

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        templateId: tpl.id,
        companyId: settings.company_id,
        name: tpl.name,
        width: args.width ?? null,
        height: args.height ?? null,
        pngBase64: args.pngBase64,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404 && /Cannot POST\s+\/upload/i.test(text)) {
        throw new Error(rendererUpgradeMessage(null));
      }
      throw new Error(`Upload service responded ${res.status}: ${text.slice(0, 500)}`);
    }
    let parsed: { success?: boolean; downloadUrl?: string; error?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Upload service returned non-JSON: ${text.slice(0, 300)}`);
    }
    if (!parsed.success) throw new Error(parsed.error || "Upload service returned success=false");

    await supabaseAdmin
      .from("templates")
      .update({
        last_published_at: new Date().toISOString(),
        last_published_url: parsed.downloadUrl ?? null,
        last_publish_status: "success",
        last_publish_error: null,
      })
      .eq("id", tpl.id);

    return { ok: true as const, downloadUrl: parsed.downloadUrl ?? null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabaseAdmin
      .from("templates")
      .update({
        last_published_at: new Date().toISOString(),
        last_publish_status: "error",
        last_publish_error: message.slice(0, 1000),
      })
      .eq("id", tpl.id);
    throw new Error(message);
  }
}

/**
 * Auto-publish from the Square sync job.
 *
 * The new browser-render flow can't run server-side, so this just records
 * which templates would have been auto-published. The user picks them up
 * from the Templates page and clicks Publish, which renders in the browser.
 */
export async function autoPublishStaleTemplates(_userId: string, _candidateTemplateIds: string[]) {
  return { published: 0, errors: [] as string[] };
}

/**
 * Step 2 (video variant): forward a browser-recorded video (MP4 or WebM) to
 * the upload service. Mirrors uploadRenderedPng.
 */
export async function uploadRenderedVideo(
  userId: string,
  args: {
    templateId: string;
    videoBase64: string;
    mimeType: string;
    width?: number;
    height?: number;
    durationMs?: number;
  },
) {
  const settings = await getRendererSettings(userId);

  const { data: tpl, error: tplErr } = await supabaseAdmin
    .from("templates")
    .select("id, name")
    .eq("id", args.templateId)
    .eq("user_id", userId)
    .maybeSingle();
  if (tplErr) throw new Error(tplErr.message);
  if (!tpl) throw new Error("Template not found");

  const url = settings.renderer_url!.replace(/\/+$/, "") + "/upload-video";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const rawToken = settings.renderer_auth_token?.trim().replace(/^Bearer\s+/i, "") ?? "";
  if (rawToken) headers.Authorization = `Bearer ${rawToken}`;

  console.log("[uploadRenderedVideo]", {
    templateId: tpl.id,
    name: tpl.name,
    width: args.width,
    height: args.height,
    mimeType: args.mimeType,
    durationMs: args.durationMs,
    videoBytesApprox: Math.floor((args.videoBase64?.length ?? 0) * 0.75),
  });

  try {
    await warnIfRendererHealthCheckFails(settings.renderer_url!, settings.renderer_auth_token);

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        templateId: tpl.id,
        companyId: settings.company_id,
        name: tpl.name,
        width: args.width ?? null,
        height: args.height ?? null,
        durationMs: args.durationMs ?? null,
        mimeType: args.mimeType,
        videoBase64: args.videoBase64,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404 && /Cannot POST\s+\/upload-video/i.test(text)) {
        throw new Error(rendererUpgradeMessage(null));
      }
      throw new Error(`Upload service responded ${res.status}: ${text.slice(0, 500)}`);
    }
    let parsed: { success?: boolean; downloadUrl?: string; error?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Upload service returned non-JSON: ${text.slice(0, 300)}`);
    }
    if (!parsed.success) throw new Error(parsed.error || "Upload service returned success=false");

    await supabaseAdmin
      .from("templates")
      .update({
        last_published_at: new Date().toISOString(),
        last_published_url: parsed.downloadUrl ?? null,
        last_publish_status: "success",
        last_publish_error: null,
      })
      .eq("id", tpl.id);

    return { ok: true as const, downloadUrl: parsed.downloadUrl ?? null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabaseAdmin
      .from("templates")
      .update({
        last_published_at: new Date().toISOString(),
        last_publish_status: "error",
        last_publish_error: message.slice(0, 1000),
      })
      .eq("id", tpl.id);
    throw new Error(message);
  }
}
