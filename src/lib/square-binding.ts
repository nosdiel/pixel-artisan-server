/**
 * Square binding helpers used by the editor.
 *
 * A binding points a template field at a Square item/variation + field. An
 * override is an explicit local string that wins over the bound value so the
 * editor never breaks when sync is down or the item was deleted.
 */

export type SquareField = "price" | "name" | "description";

export type SquareBinding = {
  itemId: string;
  variationId?: string | null;
  field: SquareField;
};

export type SquareVariation = {
  id: string;
  name: string | null;
  sku: string | null;
  priceCents: number | null;
  currency: string | null;
  ordinal: number | null;
};

export type SquareItem = {
  squareItemId: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  variations: SquareVariation[];
  imageIds: string[];
  version: number | null;
  updatedAt: string | null;
  isDeleted?: boolean;
  deletedAt?: unknown;
};

export function formatPrice(priceCents: number | null | undefined, currency: string | null | undefined): string {
  if (priceCents == null) return "";
  const amount = priceCents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

/**
 * Resolve the value for a bound field.
 * Priority: override → live Square data → cached fallback → empty string.
 */
export function resolveBoundValue(
  binding: SquareBinding | null | undefined,
  override: string | null | undefined,
  item: SquareItem | null | undefined,
  cachedFallback?: string | null,
): { value: string; source: "override" | "live" | "cache" | "empty" } {
  if (override != null && override !== "") return { value: override, source: "override" };
  if (binding && item) {
    if (binding.field === "name") return { value: item.name || "", source: "live" };
    if (binding.field === "description") return { value: item.description || "", source: "live" };
    if (binding.field === "price") {
      const variation =
        item.variations.find((v) => v.id === binding.variationId) ?? item.variations[0];
      if (variation) {
        return { value: formatPrice(variation.priceCents, variation.currency), source: "live" };
      }
    }
  }
  if (cachedFallback != null && cachedFallback !== "") {
    return { value: cachedFallback, source: "cache" };
  }
  return { value: "", source: "empty" };
}