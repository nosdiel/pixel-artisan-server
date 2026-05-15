import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { RefreshCw, AlertCircle, CheckCircle2, UploadCloud, ExternalLink } from "lucide-react";
import {
  listSquareItems,
  listTemplatesWithStatus,
  markTemplateFresh,
  startSquareSyncJob,
  stepSquareSyncJob,
  getLatestSquareSyncJob,
  setTemplateBindings,
  deleteTemplate,
} from "@/lib/square.functions";
import { publishTemplate, listTemplatesWithPublishStatus } from "@/lib/signage.functions";

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
  const saveBindings = useServerFn(setTemplateBindings);
  const deleteTpl = useServerFn(deleteTemplate);
  const publishTpl = useServerFn(publishTemplate);
  const fetchPublishStatus = useServerFn(listTemplatesWithPublishStatus);

  const itemsQ = useQuery({ queryKey: ["square-items"], queryFn: () => fetchItems() });
  const tplQ = useQuery({ queryKey: ["templates"], queryFn: () => fetchTemplates() });
  const latestJobQ = useQuery({ queryKey: ["sync-job-latest"], queryFn: () => fetchLatestJob() });
  const publishStatusQ = useQuery({
    queryKey: ["templates-publish-status"],
    queryFn: () => fetchPublishStatus(),
  });

  const publishM = useMutation({
    mutationFn: (templateId: string) => publishTpl({ data: { templateId } }),
    onSuccess: (r) => {
      toast.success(r.downloadUrl ? "Published to Firebase" : "Renderer accepted job");
      qc.invalidateQueries({ queryKey: ["templates-publish-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const publishById = new Map(
    (publishStatusQ.data?.rows ?? []).map((r) => [r.id, r] as const),
  );

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
            const updated = r.updatedCount ?? 0;
            const stale = r.staleCount ?? 0;
            const parts = [`Synced ${r.processed} items`];
            if (updated) parts.push(`${updated} template${updated === 1 ? "" : "s"} auto-updated`);
            if (stale) parts.push(`${stale} flagged stale`);
            toast.success(parts.join(" · "));
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

  const deleteM = useMutation({
    mutationFn: (templateId: string) => deleteTpl({ data: { templateId } }),
    onSuccess: () => {
      toast.success("Template deleted");
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const bindM = useMutation({
    mutationFn: (vars: { templateId: string; squareItemIds: string[] }) =>
      saveBindings({ data: vars }),
    onSuccess: () => {
      toast.success("Bindings saved");
      qc.invalidateQueries({ queryKey: ["templates"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openEdit = (t: { id: string; name: string; square_bindings: unknown }) => {
    const bindings = (t.square_bindings as Array<{ square_item_id: string }> | null) ?? [];
    setSelected(new Set(bindings.map((b) => b.square_item_id)));
    setSearch("");
    setEditing({ id: t.id, name: t.name });
  };

  const filteredItems = (itemsQ.data?.items ?? []).filter((it) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (it.name ?? "").toLowerCase().includes(q) || it.square_item_id.toLowerCase().includes(q);
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
                      {(() => {
                        const ps = publishById.get(t.id);
                        if (!ps?.last_publish_status) return null;
                        if (ps.last_publish_status === "success") {
                          return (
                            <Badge className="gap-1 bg-blue-500/15 text-blue-600 hover:bg-blue-500/15">
                              <UploadCloud className="h-3 w-3" />Published
                            </Badge>
                          );
                        }
                        return (
                          <Badge variant="destructive" className="gap-1" title={ps.last_publish_error ?? ""}>
                            <AlertCircle className="h-3 w-3" />Publish failed
                          </Badge>
                        );
                      })()}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {bindings.length} Square binding{bindings.length === 1 ? "" : "s"}
                      {(() => {
                        const ps = publishById.get(t.id);
                        if (!ps?.last_published_at) return null;
                        return (
                          <>
                            {" · Last published "}
                            {new Date(ps.last_published_at).toLocaleString()}
                            {ps.last_published_url && (
                              <a
                                href={ps.last_published_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-0.5 ml-1 underline"
                              >
                                view <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </>
                        );
                      })()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" asChild>
                      <Link to="/editor" search={{ template: t.id }}>Edit</Link>
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => openEdit(t)}>
                      Edit bindings
                    </Button>
                    {t.is_stale && (
                      <Button size="sm" variant="outline" onClick={() => freshM.mutate(t.id)} disabled={freshM.isPending}>
                        Mark fresh
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      onClick={() => publishM.mutate(t.id)}
                      disabled={publishM.isPending}
                    >
                      <UploadCloud className="h-4 w-4" />
                      {publishM.isPending && publishM.variables === t.id ? "Publishing…" : "Publish"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm(`Delete template "${t.name}"? This cannot be undone.`)) {
                          deleteM.mutate(t.id);
                        }
                      }}
                      disabled={deleteM.isPending}
                    >
                      Delete
                    </Button>
                  </div>
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

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Bind Square items</DialogTitle>
            <DialogDescription>
              {editing ? `Choose catalog items to bind to "${editing.name}". Templates go stale when a bound item's price changes.` : null}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Search items by name or ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border">
            {!itemsQ.data?.items.length ? (
              <p className="p-4 text-sm text-muted-foreground">No cached Square items. Run a sync first.</p>
            ) : !filteredItems.length ? (
              <p className="p-4 text-sm text-muted-foreground">No matches.</p>
            ) : (
              <ul className="divide-y divide-border">
                {filteredItems.map((it) => {
                  const checked = selected.has(it.square_item_id);
                  return (
                    <li key={it.square_item_id} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(it.square_item_id);
                            else next.delete(it.square_item_id);
                            return next;
                          });
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{it.name ?? "—"}</p>
                        <p className="font-mono text-xs text-muted-foreground truncate">{it.square_item_id}</p>
                      </div>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {formatPrice(it.price_cents, it.currency)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditing(null)} disabled={bindM.isPending}>Cancel</Button>
              <Button
                onClick={() => editing && bindM.mutate({ templateId: editing.id, squareItemIds: Array.from(selected) })}
                disabled={bindM.isPending}
              >
                {bindM.isPending ? "Saving…" : "Save bindings"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}