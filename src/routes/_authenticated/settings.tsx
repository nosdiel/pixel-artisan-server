import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import {
  saveSquareConnection,
  startSquareSyncJob,
  stepSquareSyncJob,
} from "@/lib/square.functions";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const [token, setToken] = useState("");
  const [env, setEnv] = useState<"production" | "sandbox">("production");
  const [siteUrl, setSiteUrl] = useState("");
  const [source, setSource] = useState<"api" | "online_site">("api");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [autoSync, setAutoSync] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);

  const save = useServerFn(saveSquareConnection);
  const startJob = useServerFn(startSquareSyncJob);
  const stepJob = useServerFn(stepSquareSyncJob);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("square_connections")
        .select("merchant_id, environment, auto_sync_enabled, last_sync_at, source, site_url")
        .maybeSingle();
      if (data) {
        setConnected(true);
        setEnv((data.environment as "production" | "sandbox") ?? "production");
        setAutoSync(!!data.auto_sync_enabled);
        setLastSync(data.last_sync_at);
        setSource((data.source as "api" | "online_site") ?? "api");
        setSiteUrl(data.site_url ?? "");
      }
    })();
  }, []);

  const handleSave = async () => {
    setLoading(true);
    try {
      if (source === "api") {
        await save({ data: { source: "api", access_token: token, environment: env } });
      } else {
        await save({ data: { source: "online_site", site_url: siteUrl } });
      }
      toast.success("Square connection saved");
      setConnected(true);
      setToken("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncProgress(0);
    try {
      const { jobId } = await startJob();
      while (true) {
        const r = await stepJob({ data: { jobId } });
        setSyncProgress(r.processed);
        if (r.done) {
          if (r.status === "succeeded") {
            toast.success(`Synced ${r.processed} items · ${r.staleCount ?? 0} templates flagged stale`);
            setLastSync(new Date().toISOString());
          }
          break;
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const toggleAuto = async (next: boolean) => {
    setAutoSync(next);
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("square_connections")
      .update({ auto_sync_enabled: next })
      .eq("user_id", u.user!.id);
    if (error) {
      setAutoSync(!next);
      toast.error(error.message);
    } else {
      toast.success(next ? "Auto-sync enabled (runs hourly)" : "Auto-sync disabled");
    }
  };

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-3xl font-bold mb-6">Settings</h1>
      <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
        <h2 className="font-semibold mb-1">Square integration</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Pull catalog data from the Square API or directly from your public Square Online ordering site.
        </p>

        <Tabs value={source} onValueChange={(v) => setSource(v as "api" | "online_site")}>
          <TabsList className="mb-4">
            <TabsTrigger value="api">Square API</TabsTrigger>
            <TabsTrigger value="online_site">Square Online site</TabsTrigger>
          </TabsList>

          <TabsContent value="api" className="space-y-3">
            <div>
              <Label>Environment</Label>
              <select
                value={env}
                onChange={(e) => setEnv(e.target.value as "production" | "sandbox")}
                className="mt-1 w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              >
                <option value="production">Production</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </div>
            <div>
              <Label>Access Token</Label>
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAAlxxxxxxx" className="mt-1" />
              <p className="text-xs text-muted-foreground mt-1">Create a Personal Access Token in your Square Developer dashboard.</p>
            </div>
            <Button onClick={handleSave} disabled={!token || loading}>{loading ? "Saving…" : "Save"}</Button>
          </TabsContent>

          <TabsContent value="online_site" className="space-y-3">
            <div>
              <Label>Square Online site URL</Label>
              <Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://your-shop.square.site" className="mt-1" />
              <p className="text-xs text-muted-foreground mt-1">
                Paste the public URL of your menu or store page. We pull product names and prices from the page's structured data — no token required.
              </p>
            </div>
            <Button onClick={handleSave} disabled={!siteUrl || loading}>{loading ? "Validating…" : "Save"}</Button>
          </TabsContent>
        </Tabs>

        {connected && (
          <>
            <div className="mt-6 pt-6 border-t border-border flex items-center justify-between gap-4">
              <div>
                <Label className="text-base">Sync now</Label>
                <p className="text-sm text-muted-foreground mt-1">
                  {syncing ? `Syncing… ${syncProgress} items processed` : "Manually pull the latest catalog and re-flag stale templates."}
                </p>
              </div>
              <Button onClick={handleSyncNow} disabled={syncing} variant="outline" className="gap-2">
                <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing" : "Sync now"}
              </Button>
            </div>

            <div className="mt-6 pt-6 border-t border-border flex items-start justify-between gap-4">
              <div>
                <Label className="text-base">Automatic catalog sync</Label>
                <p className="text-sm text-muted-foreground mt-1">Refresh prices every hour and flag stale templates automatically.</p>
                {lastSync && <p className="text-xs text-muted-foreground mt-1">Last sync: {new Date(lastSync).toLocaleString()}</p>}
              </div>
              <Switch checked={autoSync} onCheckedChange={toggleAuto} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}