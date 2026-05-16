import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type RendererSettings = {
  user_id: string;
  company_id: string | null;
  renderer_url: string | null;
  renderer_auth_token: string | null;
  auto_publish_enabled: boolean;
};

export type RendererResponse = {
  success: boolean;
  downloadUrl?: string;
  error?: string;
};

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

const REQUIRED_RENDERER_VERSION = "2026-05-16-fabric7-page-render-state";

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
  const json = JSON.parse(JSON.stringify(canvasJson)) as Record<string, any>;
  let refreshedImages = 0;
  let inlinedImageBytes = 0;
  const refreshObject = async (obj: any): Promise<void> => {
    if (!obj || typeof obj !== "object") return;
    const path = typeof obj.imageStoragePath === "string"
      ? obj.imageStoragePath
      : typeof obj.src === "string"
        ? extractImageStoragePath(obj.src)
        : null;
    if (path) {
      const { data, error } = await supabaseAdmin.storage.from("images").createSignedUrl(path, 3600);
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
    await Promise.all(((obj.objects ?? obj._objects ?? []) as any[]).map(refreshObject));
    if (obj.clipPath) await refreshObject(obj.clipPath);
  };
  await Promise.all(((json.objects ?? []) as any[]).map(refreshObject));
  if (json.backgroundImage) await refreshObject(json.backgroundImage);
  return { canvasJson: json, refreshedImages, inlinedImageBytes };
}

export async function checkRendererHealth(rendererUrl: string, rendererAuthToken: string | null): Promise<RendererHealthResponse> {
  const url = rendererUrl.replace(/\/+$/, "") + "/health";
  const parsed = new URL(url);
  const rawToken = rendererAuthToken?.trim().replace(/^Bearer\s+/i, "") ?? "";
  const headers: Record<string, string> = { Accept: "application/json, text/plain, */*" };
  if (rawToken) headers.Authorization = `Bearer ${rawToken}`;

  if (parsed.protocol === "http:") return rawHttpRequest("GET", parsed, headers);

  const res = await fetch(url, { method: "GET", headers, redirect: "follow" });
  const body = await res.text();
  return { ok: res.ok, status: res.status, statusText: res.statusText, url, body: body.slice(0, 2000) };
}

async function rawHttpRequest(method: "GET" | "POST", parsed: URL, headers: Record<string, string>, body = ""): Promise<RendererHealthResponse> {
  const url = parsed.toString();
  return new Promise((resolve) => {
    const port = parsed.port ? Number(parsed.port) : 80;
    import("node:net")
      .then(({ createConnection }) => {
        const socket = createConnection({ host: parsed.hostname, port });
        let raw = "";
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(parseRawHttpResponse(raw, url));
        };

        socket.setTimeout(15000);
        socket.on("connect", () => {
          const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n");
          const bodyHeaders = body ? `\r\nContent-Length: ${Buffer.byteLength(body)}` : "";
          socket.write(`${method} ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\n${headerLines}${bodyHeaders}\r\nConnection: close\r\n\r\n${body}`);
        });
        socket.on("data", (chunk) => { raw += chunk.toString(); });
        socket.on("end", finish);
        socket.on("close", finish);
        socket.on("timeout", () => socket.destroy(new Error("Renderer request timed out after 15 seconds")));
        socket.on("error", (e) => {
          if (settled) return;
          settled = true;
          resolve({ ok: false, status: 0, statusText: "Request failed", url, body: e.message });
        });
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        resolve({ ok: false, status: 0, statusText: "Request failed", url, body: message });
      });
  });
}

function parseRawHttpResponse(raw: string, url: string): RendererHealthResponse {
  const splitAt = raw.indexOf("\r\n\r\n");
  const head = splitAt >= 0 ? raw.slice(0, splitAt) : raw;
  const body = splitAt >= 0 ? raw.slice(splitAt + 4) : "";
  const statusLine = head.split(/\r?\n/)[0] ?? "";
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/);
  const status = match ? Number(match[1]) : 0;
  const statusText = match?.[2] || "";
  const decodedBody = /transfer-encoding:\s*chunked/i.test(head) ? decodeChunkedBody(body) : body;
  return { ok: status >= 200 && status < 300, status, statusText, url, body: decodedBody.slice(0, 2000) };
}

function decodeChunkedBody(body: string) {
  let index = 0;
  let decoded = "";
  while (index < body.length) {
    const lineEnd = body.indexOf("\r\n", index);
    if (lineEnd < 0) break;
    const size = parseInt(body.slice(index, lineEnd), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const chunkStart = lineEnd + 2;
    decoded += body.slice(chunkStart, chunkStart + size);
    index = chunkStart + size + 2;
  }
  return decoded || body;
}

function paethPredictor(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

async function isBlankWhitePng(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((n, i) => bytes[i] === n)) return false;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const length = view.readUInt32BE(0);
    const type = view.subarray(4, 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > bytes.length) break;
    const data = Buffer.from(bytes.subarray(dataStart, dataEnd));
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !bpp || !idat.length) return false;

  const { inflateSync } = await import("node:zlib");
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  let src = 0;
  let nonWhite = 0;
  let total = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const raw = inflated[src++];
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= bpp ? prev[x - bpp] ?? 0 : 0;
      row[x] = (raw + (filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paethPredictor(left, up, upLeft) : 0)) & 255;
    }
    for (let x = 0; x < width; x++) {
      const i = x * bpp;
      const r = colorType === 0 ? row[i] : row[i];
      const g = colorType === 0 ? row[i] : row[i + 1];
      const b = colorType === 0 ? row[i] : row[i + 2];
      const a = colorType === 6 ? row[i + 3] : colorType === 4 ? row[i + 1] : 255;
      if (a > 5) {
        total++;
        if (r < 250 || g < 250 || b < 250) nonWhite++;
      }
    }
    prev = row;
  }
  return total > 0 && nonWhite / total < 0.0005;
}

async function assertRenderedPngHasContent(downloadUrl: string | undefined) {
  if (!downloadUrl) return;
  const res = await fetch(downloadUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Could not verify rendered PNG (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (await isBlankWhitePng(bytes)) {
    throw new Error("Renderer returned a blank white PNG. The configured renderer is still running broken render code; redeploy renderer-service/server.js and retry.");
  }
}

function isBlankRendererError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return message.toLowerCase().includes("blank white png");
}

async function getLatestSavedTemplateImageUrl(userId: string, templateId: string) {
  const { data, error } = await supabaseAdmin
    .from("images")
    .select("variants")
    .eq("user_id", userId)
    .eq("template_id", templateId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const variants = Array.isArray(data?.variants) ? data.variants as Array<{ path?: string; format?: string; size?: number }> : [];
  const selected = variants.find((v) => v.format === "webp" && v.path) ?? variants.find((v) => v.path);
  if (!selected?.path) return null;

  const { data: signed, error: signError } = await supabaseAdmin.storage.from("images").createSignedUrl(selected.path, 7 * 24 * 60 * 60);
  if (signError) throw new Error(`Could not prepare saved template image: ${signError.message}`);
  return signed?.signedUrl ?? null;
}

async function assertRendererIsCurrent(rendererUrl: string, rendererAuthToken: string | null) {
  const health = await checkRendererHealth(rendererUrl, rendererAuthToken);
  if (!health.ok) throw new Error(`Renderer health check failed: ${health.status} ${health.body}`);
  let payload: { rendererVersion?: string } | null = null;
  try {
    payload = JSON.parse(health.body) as { rendererVersion?: string };
  } catch {
    // handled below
  }
  if (payload?.rendererVersion !== REQUIRED_RENDERER_VERSION) {
    throw new Error("Renderer service is outdated. Redeploy renderer-service/server.js, then retry publish.");
  }
}

/**
 * POST a template payload to the user's external renderer service.
 * The renderer is responsible for:
 *  - rendering the canvas to PNG
 *  - uploading to Firebase Storage at rendered/{companyId}/{templateId}/latest.png
 *  - writing/updating the Firestore doc with downloadUrl + status
 *  - returning { success, downloadUrl }
 */
export async function callRenderer(args: {
  rendererUrl: string;
  rendererAuthToken: string | null;
  payload: {
    templateId: string;
    companyId: string;
    name: string;
    width: number;
    height: number;
    canvasJson: unknown;
    squareData: Array<{ square_item_id: string; name: string | null; price_cents: number | null; currency: string | null }>;
  };
}): Promise<RendererResponse> {
  const url = args.rendererUrl.replace(/\/+$/, "") + "/render";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const rawToken = args.rendererAuthToken?.trim().replace(/^Bearer\s+/i, "") ?? "";
  if (rawToken) headers.Authorization = `Bearer ${rawToken}`;
  const body = JSON.stringify(args.payload);

  const parsed = new URL(url);
  const response = parsed.protocol === "http:"
    ? await rawHttpRequest("POST", parsed, headers, body)
    : await fetch(url, { method: "POST", headers, body }).then(async (res) => ({
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url,
      body: await res.text(),
    }));

  if (!response.ok) {
    throw new Error(`Renderer responded ${response.status}: ${response.body.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(response.body) as RendererResponse;
  } catch {
    throw new Error(`Renderer returned non-JSON response: ${response.body.slice(0, 500)}`);
  }
}

/**
 * Render & publish a single template via the user's renderer.
 * Updates `templates.last_published_*` columns with the result.
 */
export async function publishTemplateToRenderer(userId: string, templateId: string) {
  const { data: settings } = await supabaseAdmin
    .from("signage_settings")
    .select("company_id, renderer_url, renderer_auth_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (!settings?.renderer_url) throw new Error("Renderer URL is not configured. Add it in Settings → Signage publishing.");
  if (!settings.company_id) throw new Error("Company ID is not configured. Add it in Settings → Signage publishing.");
  await assertRendererIsCurrent(settings.renderer_url, settings.renderer_auth_token);

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
  const objectCount = Array.isArray(originalCanvasJson?.objects) ? originalCanvasJson!.objects!.length : 0;
  const { canvasJson, refreshedImages, inlinedImageBytes } = originalCanvasJson
    ? await refreshCanvasMediaUrls(originalCanvasJson)
    : { canvasJson: null, refreshedImages: 0, inlinedImageBytes: 0 };
  console.log("[publishTemplate]", {
    templateId: tpl.id,
    name: tpl.name,
    width: renderWidth,
    height: renderHeight,
    savedWidth: tpl.width,
    savedHeight: tpl.height,
    hasCanvasJson: !!originalCanvasJson,
    objectCount,
    refreshedImages,
    inlinedImageBytes,
    canvasJsonPreview: canvasJson ? JSON.stringify(canvasJson).slice(0, 300) : null,
  });
  if (!originalCanvasJson || objectCount === 0) {
    const msg = "Template has no objects.";
    await supabaseAdmin
      .from("templates")
      .update({
        last_published_at: new Date().toISOString(),
        last_publish_status: "error",
        last_publish_error: msg,
      })
      .eq("id", tpl.id);
    throw new Error(msg);
  }

  const bindings = (tpl.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
  const ids = bindings.map((b) => b.square_item_id);
  let squareData: Array<{ square_item_id: string; name: string | null; price_cents: number | null; currency: string | null }> = [];
  if (ids.length) {
    const { data: items } = await supabaseAdmin
      .from("square_items_cache")
      .select("square_item_id, name, price_cents, currency")
      .eq("user_id", userId)
      .in("square_item_id", ids);
    squareData = items ?? [];
  }

  try {
    const result = await callRenderer({
      rendererUrl: settings.renderer_url,
      rendererAuthToken: settings.renderer_auth_token,
      payload: {
        templateId: tpl.id,
        companyId: settings.company_id,
        name: tpl.name,
        width: renderWidth,
        height: renderHeight,
        canvasJson,
        squareData,
      },
    });

    if (!result.success) throw new Error(result.error || "Renderer returned success=false");
    try {
      await assertRenderedPngHasContent(result.downloadUrl);
    } catch (verifyError) {
      if (!isBlankRendererError(verifyError)) throw verifyError;
      const fallbackUrl = await getLatestSavedTemplateImageUrl(userId, tpl.id);
      if (!fallbackUrl) throw verifyError;
      console.warn("[publishTemplate] renderer returned blank output; using latest saved editor image", { templateId: tpl.id });
      result.downloadUrl = fallbackUrl;
      await assertRenderedPngHasContent(result.downloadUrl);
    }

    await supabaseAdmin
      .from("templates")
      .update({
        last_published_at: new Date().toISOString(),
        last_published_url: result.downloadUrl ?? null,
        last_publish_status: "success",
        last_publish_error: null,
      })
      .eq("id", tpl.id);

    return { ok: true as const, downloadUrl: result.downloadUrl ?? null };
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

/** Auto-publish every template flagged stale or just auto-updated for this user, if enabled. */
export async function autoPublishStaleTemplates(userId: string, candidateTemplateIds: string[]) {
  if (!candidateTemplateIds.length) return { published: 0, errors: [] as string[] };
  const { data: settings } = await supabaseAdmin
    .from("signage_settings")
    .select("auto_publish_enabled, renderer_url, company_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!settings?.auto_publish_enabled) return { published: 0, errors: [] };
  if (!settings.renderer_url || !settings.company_id) return { published: 0, errors: ["renderer not configured"] };

  let published = 0;
  const errors: string[] = [];
  for (const id of candidateTemplateIds) {
    try {
      await publishTemplateToRenderer(userId, id);
      published++;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { published, errors };
}