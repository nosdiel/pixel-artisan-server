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

/**
 * Pull catalog items from a public Square Online ordering site.
 *
 * Strategy: fetch the page HTML and extract structured product data from
 * JSON-LD `<script type="application/ld+json">` blocks. Square Online sites
 * (Weebly-based) emit JSON-LD `Product` entries for each menu item, which is
 * the most stable public source of names, prices and descriptions.
 */
export async function fetchOnlineSiteCatalog(siteUrl: string): Promise<FlatItem[]> {
  const url = normalizeSiteUrl(siteUrl);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LovableSignageBot/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Square Online site error ${res.status}: failed to load ${url}`);
  }
  const html = await res.text();
  const products = extractJsonLdProducts(html);
  if (!products.length) {
    throw new Error(
      "No products found on the page. Make sure the URL points to a Square Online menu/store page that lists items.",
    );
  }
  return products.map(productToFlat);
}

function normalizeSiteUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
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
  if (types.some((v) => typeof v === "string" && v.toLowerCase() === "product")) {
    out.push(obj as LdProduct);
  }
  // Walk common container keys
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