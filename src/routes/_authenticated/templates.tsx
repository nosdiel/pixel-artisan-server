import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  syncSquareCatalog,
  listSquareItems,
  listTemplatesWithStatus,
  markTemplateFresh,
} from "@/lib/square.functions";

export const Route = createFileRoute("/_authenticated/templates")({ component: TemplatesPage });

function formatPrice(cents: number | null, currency: string | null) {
  if (cents == null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
  }).format(cents / 100);
}

function TemplatesPage() {
  const qc = useQueryClient();
  const sync = useServerFn(syncSquareCatalog);
  const fetchItems = useServerFn(listSquareItems);
  const fetchTemplates = useServerFn(listTemplatesWithStatus);
  const fresh = useServerFn(markTemplateFresh);

  const itemsQ = useQuery({ queryKey: ["square-items"], queryFn: () => fetchItems() });
  const tplQ = useQuery({ queryKey: ["templates"], queryFn: () => fetchTemplates() });

  const syncM = useMutation({
    mutationFn: () => sync(),
    onSuccess: (r) => {
      toast.success(`Synced ${r.itemCount} items · ${r.staleCount} templates marked stale`);
      qc.invalidateQueries({ queryKey: ["square-items"] });
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const freshM = useMutation({
    mutationFn: (templateId: string) => fresh({ data: { templateId } }),
    onSuccess: () => {
      toast.success("Template marked fresh");
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-8 max-w-5xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Templates &amp; Square sync</h1>
          <p className="text-muted-foreground mt-1">Bind Square catalog items to templates. We flag templates as stale when prices change.</p>
        </div>
        <Button onClick={() => syncM.mutate()} disabled={syncM.isPending} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${syncM.isPending ? "animate-spin" : ""}`} />
          {syncM.isPending ? "Syncing…" : "Sync Square catalog"}
        </Button>
      </div>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="font-semibold mb-3">Templates</h2>
        {tplQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !tplQ.data?.templates.length ? (
          <p className="text-sm text-muted-foreground">No templates yet. Create one from the Editor.</p>
        ) : (
          <ul className="divide-y divide-border">
            {tplQ.data.templates.map((t) => {
              const bindings = (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
              return (
                <li key={t.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{t.name}</span>
                      <Badge variant="secondary">{t.preset}</Badge>
                      {t.is_stale ? (
                        <Badge variant="destructive" className="gap-1"><AlertCircle className="h-3 w-3" />Stale</Badge>
                      ) : (
                        <Badge className="gap-1 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15"><CheckCircle2 className="h-3 w-3" />Fresh</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{bindings.length} Square binding{bindings.length === 1 ? "" : "s"}</p>
                  </div>
                  {t.is_stale && (
                    <Button size="sm" variant="outline" onClick={() => freshM.mutate(t.id)} disabled={freshM.isPending}>
                      Mark fresh
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="font-semibold mb-3">Square catalog cache</h2>
        {itemsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !itemsQ.data?.items.length ? (
          <p className="text-sm text-muted-foreground">No cached items. Connect Square in Settings, then click Sync.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-2 pr-4">Item</th><th className="py-2 pr-4">Price</th><th className="py-2 pr-4">ID</th></tr>
              </thead>
              <tbody>
                {itemsQ.data.items.map((it) => (
                  <tr key={it.square_item_id} className="border-t border-border">
                    <td className="py-2 pr-4">{it.name ?? "—"}</td>
                    <td className="py-2 pr-4 tabular-nums">{formatPrice(it.price_cents, it.currency)}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{it.square_item_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}