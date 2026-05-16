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

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(args.payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Renderer responded ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as RendererResponse;
  } catch {
    throw new Error(`Renderer returned non-JSON response: ${text.slice(0, 200)}`);
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

  const { data: tpl, error: tplErr } = await supabaseAdmin
    .from("templates")
    .select("id, name, width, height, canvas_json, square_bindings")
    .eq("id", templateId)
    .eq("user_id", userId)
    .maybeSingle();
  if (tplErr) throw new Error(tplErr.message);
  if (!tpl) throw new Error("Template not found");

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
        width: tpl.width,
        height: tpl.height,
        canvasJson: tpl.canvas_json,
        squareData,
      },
    });

    if (!result.success) throw new Error(result.error || "Renderer returned success=false");

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