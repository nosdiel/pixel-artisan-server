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

const TOAST_HOSTS = {
  production: "https://ws-api.toasttab.com",
  sandbox: "https://ws-sandbox-api.toasttab.com",
} as const;

type ToastEnv = keyof typeof TOAST_HOSTS;

async function getToastToken(env: ToastEnv, clientId: string, clientSecret: string): Promise<string> {
  const host = TOAST_HOSTS[env] ?? TOAST_HOSTS.production;
  const res = await fetch(`${host}/authentication/v1/authentication/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ clientId, clientSecret, userAccessType: "TOAST_MACHINE_CLIENT" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Toast auth error ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { token?: { accessToken?: string } };
  const token = json.token?.accessToken;
  if (!token) throw new Error("Toast auth response missing accessToken");
  return token;
}

type ToastMenuItem = {
  guid?: string;
  name?: string;
  description?: string;
  price?: number; // dollars
  visibility?: string[];
};
type ToastMenuGroup = {
  name?: string;
  menuGroups?: ToastMenuGroup[];
  menuItems?: ToastMenuItem[];
};
type ToastMenu = { name?: string; menuGroups?: ToastMenuGroup[] };
type ToastMenusResponse = { menus?: ToastMenu[] };

function walkGroups(
  groups: ToastMenuGroup[] | undefined,
  parentCategory: string | null,
  out: Array<{ item: ToastMenuItem; category: string | null }>,
) {
  for (const g of groups ?? []) {
    const cat = g.name ?? parentCategory;
    for (const item of g.menuItems ?? []) out.push({ item, category: cat });
    walkGroups(g.menuGroups, cat, out);
  }
}

export async function fetchToastCatalog(opts: {
  environment: string;
  clientId: string;
  clientSecret: string;
  restaurantGuid: string;
}): Promise<FlatItem[]> {
  const env: ToastEnv = opts.environment === "sandbox" ? "sandbox" : "production";
  const token = await getToastToken(env, opts.clientId, opts.clientSecret);
  const host = TOAST_HOSTS[env];
  const res = await fetch(`${host}/menus/v2/menus`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Toast-Restaurant-External-ID": opts.restaurantGuid,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Toast menus error ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as ToastMenusResponse;

  const collected: Array<{ item: ToastMenuItem; category: string | null }> = [];
  for (const menu of json.menus ?? []) {
    walkGroups(menu.menuGroups, menu.name ?? null, collected);
  }

  const seen = new Set<string>();
  const out: FlatItem[] = [];
  for (const { item, category } of collected) {
    const id = item.guid ?? item.name;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      square_item_id: id,
      name: item.name ?? null,
      description: item.description ?? null,
      category,
      price_cents: typeof item.price === "number" ? Math.round(item.price * 100) : null,
      currency: "USD",
      raw: item as unknown as Json,
    });
  }
  return out;
}