import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RefreshCw, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  listSquareItems,
  listTemplatesWithStatus,
  markTemplateFresh,
  startSquareSyncJob,
  stepSquareSyncJob,
  getLatestSquareSyncJob,
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
  const fetchItems = useServerFn(listSquareItems);
  const fetchTemplates = useServerFn(listTemplatesWithStatus);
  const fresh = useServerFn(markTemplateFresh);
  const startJob = useServerFn(startSquareSyncJob);
  const stepJob = useServerFn(stepSquareSyncJob);
  const fetchLatestJob = useServerFn(getLatestSquareSyncJob);

  const itemsQ = useQuery({ queryKey: ["square-items"], queryFn: () => fetchItems() });
  const tplQ = useQuery({ queryKey: ["templates"], queryFn: () => fetchTemplates() });
  const latestJobQ = useQuery({ queryKey: ["sync-job-latest"], queryFn: () => fetchLatestJob() });

  const [running, setRunning] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const cancelRef = useRef(false);

  // Resume an in-flight job if the page was reloaded mid-sync
  useEffect(() => {
    const job = latestJobQ.data?.job;
    if (job?.status === "running" && !running) {
      setActiveJobId(job.id);
      setProcessed(job.processed_items);
      runJobLoop(job.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestJobQ.data?.job?.id]);

  async function runJobLoop(jobId: string) {
    setRunning(true);
    cancelRef.current = false;
    try {
      while (!cancelRef.current) {
        const r = await stepJob({ data: { jobId } });
        setProcessed(r.processed);
        if (r.done) {
          if (r.status === "succeeded") {
            toast.success(`Synced ${r.processed} items · ${r.staleCount ?? 0} templates marked stale`);
          }
          break;
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setActiveJobId(null);
      qc.invalidateQueries({ queryKey: ["square-items"] });
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["sync-job-latest"] });
    }
  }

  async function handleStart() {
    try {
      setProcessed(0);
      const { jobId } = await startJob();
      setActiveJobId(jobId);
      runJobLoop(jobId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const freshM = useMutation({
    mutationFn: (templateId: string) => fresh({ data: { templateId } }),
    onSuccess: () => {
      toast.success("Template marked fresh");
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const lastJob = latestJobQ.data?.job;

  return (
    <div className="p-8 max-w-5xl space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Templates &amp; Square sync</h1>
          <p className="text-muted-foreground mt-1">Bind Square catalog items to templates. We flag templates as stale when prices change.</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button onClick={handleStart} disabled={running} className="gap-2">
              <RefreshCw className={`h-4 w-4 ${running ? "animate-spin" : ""}`} />
              {running ? "Syncing…" : "Sync Square catalog"}
            </Button>
            {running && (
              <Button variant="outline" onClick={() => { cancelRef.current = true; }}>
                Stop
              </Button>
            )}
          </div>
          {!running && lastJob && (
            <p className="text-xs text-muted-foreground">
              Last sync: {lastJob.status} · {lastJob.processed_items} items
              {lastJob.finished_at ? ` · ${new Date(lastJob.finished_at).toLocaleString()}` : ""}
            </p>
          )}
        </div>
      </div>

      {(running || activeJobId) && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-card)]">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-medium">Background sync in progress</span>
            <span className="tabular-nums text-muted-foreground">{processed} items processed</span>
          </div>
          <div className="h-2 w-full rounded-full bg-primary/15 overflow-hidden">
            <div className="h-full w-1/3 bg-primary animate-[indeterminate_1.4s_ease-in-out_infinite]" />
          </div>
          <p className="text-xs text-muted-foreground mt-2">You can navigate away — the sync will resume if you return before it finishes.</p>
        </div>
      )}

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