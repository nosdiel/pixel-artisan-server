import type { Json } from "@/integrations/supabase/types";

type FlatItem = {
  square_item_id: string;
  name: string | null;
  description: string | null;
  category: string | null;
  price_cents: number | null;
  currency: string;
  raw: Json;
};

type BootstrapState = {
  siteData?: {
    user?: { id?: string | number };
    site?: {
      id?: string;
      properties?: {
        catalogSiteId?: string;
        classicSiteID?: string;
      };
    };
  };
  storeInfo?: { currency?: string };
  commerceLinks?: {
    categories?: Record<string, { name?: string; site_category_id?: string }>;
  };
  featureFlags?: Record<string, unknown>;
};

type OnlineProduct = Record<string, unknown> & {
  id?: string;
  square_id?: string;
  site_product_id?: string;
  name?: string;
  short_description?: string;
  description?: string;
  categoryIds?: string[];
  price?: {
    low_subunits?: number;
    high_subunits?: number;
    low?: number;
    high?: number;
    currency?: string;
  };
};

type OnlineSku = {
  id?: string;
  square_id?: string;
  name?: string | null;
  price?: {
    current_subunits?: number;
    current?: number;
  };
};

/** Pull catalog items from a public Square Online ordering page. */
export async function fetchOnlineSiteCatalog(siteUrl: string): Promise<FlatItem[]> {
  const url = normalizeSiteUrl(siteUrl);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/json",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Square Online site error ${res.status}: failed to load ${url}`);

  const html = await res.text();
  const bootstrap = extractBootstrapState(html);
  const apiItems = bootstrap ? await fetchSquareOnlineApiItems(url, bootstrap) : [];
  if (apiItems.length) return apiItems;

  return extractJsonLdProducts(html).map(productToFlat);
}

function normalizeSiteUrl(input: string): URL {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return new URL(s);
}

function extractBootstrapState(html: string): BootstrapState | null {
  const marker = "window.__BOOTSTRAP_STATE__ =";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = html.indexOf("{", markerIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as BootstrapState;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchSquareOnlineApiItems(siteUrl: URL, bootstrap: BootstrapState): Promise<FlatItem[]> {
  const ownerId = bootstrap.siteData?.user?.id?.toString();
  const siteId = bootstrap.siteData?.site?.properties?.catalogSiteId ?? bootstrap.siteData?.site?.properties?.classicSiteID;
  if (!ownerId || !siteId) return [];

  const locationId = siteUrl.searchParams.get("location");
  const apiBase = new URL(
    `/app/store/api/v28/editor/users/${encodeURIComponent(ownerId)}/sites/${encodeURIComponent(siteId)}`,
    "https://cdn5.editmysite.com",
  );
  const productsUrl = new URL(`${apiBase.pathname}${locationId ? `/store-locations/${encodeURIComponent(locationId)}` : ""}/products`, apiBase.origin);
  const cacheVersion = bootstrap.featureFlags?.["ecom.square-online-published-catalog-cache-version"];
  const products: OnlineProduct[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const pageUrl = new URL(productsUrl);
    pageUrl.searchParams.set("page", String(page));
    pageUrl.searchParams.set("per_page", "100");
    pageUrl.searchParams.set("lang", "en");
    pageUrl.searchParams.append("visibilities[]", "visible");
    if (typeof cacheVersion === "string") pageUrl.searchParams.set("cache-version", cacheVersion);

    const res = await fetch(pageUrl, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: siteUrl.origin,
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      redirect: "follow",
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: OnlineProduct[]; meta?: { pagination?: { total_pages?: number } } };
    products.push(...(json.data ?? []));
    totalPages = json.meta?.pagination?.total_pages ?? 1;
    page += 1;
  } while (page <= totalPages && page <= 20);

  const categories = bootstrap.commerceLinks?.categories ?? {};
  const currency = bootstrap.storeInfo?.currency ?? "USD";
  const productHeaders: HeadersInit = {
    Accept: "application/json, text/plain, */*",
    Referer: siteUrl.origin,
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
  const fetchSkus = async (productId: string): Promise<OnlineSku[]> => {
    const detailUrl = new URL(`${apiBase.pathname}/products/${encodeURIComponent(productId)}`, apiBase.origin);
    detailUrl.searchParams.set("include", "skus");
    detailUrl.searchParams.set("lang", "en");
    try {
      const r = await fetch(detailUrl, { headers: productHeaders, redirect: "follow" });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: { skus?: { data?: OnlineSku[] } } };
      return j.data?.skus?.data ?? [];
    } catch {
      return [];
    }
  };

  const out: FlatItem[] = [];
  for (const product of products) {
    const low = product.price?.low_subunits ?? product.price?.low;
    const high = product.price?.high_subunits ?? product.price?.high;
    const hasRange = low != null && high != null && low !== high;
    const productId = product.square_id ?? product.id;
    if (hasRange && productId) {
      const skus = await fetchSkus(productId);
      const usable = skus.filter((s) => (s.price?.current_subunits ?? s.price?.current) != null);
      if (usable.length > 1) {
        for (const sku of usable) {
          out.push(skuToFlat(product, sku, categories, currency));
        }
        continue;
      }
    }
    out.push(onlineProductToFlat(product, categories, currency));
  }
  return dedupe(out);
}

function onlineProductToFlat(product: OnlineProduct, categories: NonNullable<BootstrapState["commerceLinks"]>["categories"], currency: string): FlatItem {
  const categoryId = product.categoryIds?.find((id) => categories?.[id]?.name) ?? product.categoryIds?.[0];
  const priceSubunits = product.price?.low_subunits ?? product.price?.high_subunits;
  const priceUnits = product.price?.low ?? product.price?.high;
  const price_cents = typeof priceSubunits === "number" ? priceSubunits : typeof priceUnits === "number" ? Math.round(priceUnits * 100) : null;
  return {
    square_item_id: String(product.square_id ?? product.id ?? product.site_product_id ?? product.name ?? crypto.randomUUID()),
    name: product.name ?? null,
    description: cleanText(product.short_description ?? product.description ?? null),
    category: categoryId ? categories?.[categoryId]?.name ?? categoryId : null,
    price_cents,
    currency: product.price?.currency ?? currency,
    raw: product as unknown as Json,
  };
}

function skuToFlat(product: OnlineProduct, sku: OnlineSku, categories: NonNullable<BootstrapState["commerceLinks"]>["categories"], currency: string): FlatItem {
  const categoryId = product.categoryIds?.find((id) => categories?.[id]?.name) ?? product.categoryIds?.[0];
  const productId = product.square_id ?? product.id ?? product.site_product_id ?? product.name ?? "item";
  const skuId = sku.square_id ?? sku.id ?? sku.name ?? crypto.randomUUID();
  const cents = sku.price?.current_subunits ?? (typeof sku.price?.current === "number" ? Math.round(sku.price.current * 100) : null);
  const variantName = sku.name?.trim() || "Default";
  return {
    square_item_id: `${productId}:${skuId}`,
    name: product.name ? `${product.name} — ${variantName}` : variantName,
    description: cleanText(product.short_description ?? product.description ?? null),
    category: categoryId ? categories?.[categoryId]?.name ?? categoryId : null,
    price_cents: cents,
    currency: product.price?.currency ?? currency,
    raw: { ...(product as Record<string, unknown>), _sku: sku } as unknown as Json,
  };
}

function dedupe(items: FlatItem[]): FlatItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.square_item_id)) return false;
    seen.add(item.square_item_id);
    return true;
  });
}

function cleanText(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
}

type LdProduct = {
  "@type"?: string | string[];
  name?: string;
  description?: string;
  sku?: string;
  productID?: string;
  "@id"?: string;
  category?: string | { name?: string };
  offers?:
    | { price?: string | number; priceCurrency?: string; sku?: string }
    | Array<{ price?: string | number; priceCurrency?: string; sku?: string }>;
};

function extractJsonLdProducts(html: string): LdProduct[] {
  const out: LdProduct[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    collectProducts(parsed, out);
  }
  return out;
}

function collectProducts(node: unknown, out: LdProduct[]) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach((n) => collectProducts(n, out)); return; }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const t = obj["@type"];
  const types = Array.isArray(t) ? t : [t];
  if (types.some((v) => typeof v === "string" && v.toLowerCase() === "product")) out.push(obj as LdProduct);
  for (const key of ["@graph", "itemListElement", "hasPart", "mainEntity"]) {
    if (key in obj) collectProducts(obj[key], out);
  }
}

function productToFlat(p: LdProduct): FlatItem {
  const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
  const priceRaw = offer?.price;
  const priceNum = typeof priceRaw === "string" ? parseFloat(priceRaw) : typeof priceRaw === "number" ? priceRaw : null;
  const price_cents = priceNum != null && !Number.isNaN(priceNum) ? Math.round(priceNum * 100) : null;
  const id = (p.sku || p.productID || p["@id"] || offer?.sku || p.name || crypto.randomUUID()) as string;
  const category = typeof p.category === "string" ? p.category : p.category?.name ?? null;
  return {
    square_item_id: String(id),
    name: p.name ?? null,
    description: p.description ?? null,
    category,
    price_cents,
    currency: offer?.priceCurrency ?? "USD",
    raw: p as unknown as Json,
  };
}