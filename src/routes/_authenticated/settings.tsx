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
import {
  getSignageSettings,
  saveSignageSettings,
  testRenderer,
} from "@/lib/signage.functions";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const [token, setToken] = useState("");
  const [env, setEnv] = useState<"production" | "sandbox">("production");
  const [siteUrl, setSiteUrl] = useState("");
  const [source, setSource] = useState<"api" | "online_site" | "toast_api">("api");
  const [toastClientId, setToastClientId] = useState("");
  const [toastClientSecret, setToastClientSecret] = useState("");
  const [toastRestaurantGuid, setToastRestaurantGuid] = useState("");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [autoSync, setAutoSync] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);

  const save = useServerFn(saveSquareConnection);
  const startJob = useServerFn(startSquareSyncJob);
  const stepJob = useServerFn(stepSquareSyncJob);
  const fetchSignage = useServerFn(getSignageSettings);
  const saveSignage = useServerFn(saveSignageSettings);
  const pingRenderer = useServerFn(testRenderer);

  const [companyId, setCompanyId] = useState("");
  const [rendererUrl, setRendererUrl] = useState("");
  const [rendererToken, setRendererToken] = useState("");
  const [autoPublish, setAutoPublish] = useState(false);
  const [signageSaving, setSignageSaving] = useState(false);
  const [signageTesting, setSignageTesting] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("square_connections")
        .select("merchant_id, environment, auto_sync_enabled, last_sync_at, source, site_url, client_id, restaurant_guid")
        .maybeSingle();
      if (data) {
        setConnected(true);
        setEnv((data.environment as "production" | "sandbox") ?? "production");
        setAutoSync(!!data.auto_sync_enabled);
        setLastSync(data.last_sync_at);
        setSource((data.source as "api" | "online_site" | "toast_api") ?? "api");
        setSiteUrl(data.site_url ?? "");
        setToastClientId(data.client_id ?? "");
        setToastRestaurantGuid(data.restaurant_guid ?? "");
      }
      try {
        const r = await fetchSignage();
        if (r.settings) {
          setCompanyId(r.settings.company_id ?? "");
          setRendererUrl(r.settings.renderer_url ?? "");
          setRendererToken(r.settings.renderer_auth_token ?? "");
          setAutoPublish(!!r.settings.auto_publish_enabled);
        }
      } catch {
        /* ignore — settings may not exist yet */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveSignage = async () => {
    setSignageSaving(true);
    try {
      await saveSignage({
        data: {
          company_id: companyId.trim(),
          renderer_url: rendererUrl.trim(),
          renderer_auth_token: rendererToken.trim() || null,
          auto_publish_enabled: autoPublish,
        },
      });
      toast.success("Signage publishing settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSignageSaving(false);
    }
  };

  const handleTestRenderer = async () => {
    setSignageTesting(true);
    try {
      const r = await pingRenderer({
        data: {
          renderer_url: rendererUrl.trim(),
          renderer_auth_token: rendererToken.trim() || null,
        },
      });
      if (!r.ok) {
        toast.error(`Renderer health check failed (${r.status || "network"}): ${r.body || r.statusText}`);
        return;
      }
      toast.success(`Renderer reachable${r.body ? ` · ${r.body}` : ""}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSignageTesting(false);
    }
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      if (source === "api") {
        await save({ data: { source: "api", access_token: token, environment: env } });
      } else if (source === "online_site") {
        await save({ data: { source: "online_site", site_url: siteUrl } });
      } else {
        await save({
          data: {
            source: "toast_api",
            environment: env,
            client_id: toastClientId,
            client_secret: toastClientSecret,
            restaurant_guid: toastRestaurantGuid,
          },
        });
      }
      toast.success("POS connection saved");
      setConnected(true);
      setToken("");
      setToastClientSecret("");
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
            const updated = r.updatedCount ?? 0;
            const stale = r.staleCount ?? 0;
            const parts = [`Synced ${r.processed} items`];
            if (updated) parts.push(`${updated} auto-updated`);
            if (stale) parts.push(`${stale} flagged stale`);
            toast.success(parts.join(" · "));
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
        <h2 className="font-semibold mb-1">POS integration</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Choose which point-of-sale system to sync your catalog from.
        </p>

        <Tabs value={source} onValueChange={(v) => setSource(v as "api" | "online_site" | "toast_api")}>
          <TabsList className="mb-4">
            <TabsTrigger value="api">Square API</TabsTrigger>
            <TabsTrigger value="online_site">Square Online site</TabsTrigger>
            <TabsTrigger value="toast_api">Toast API</TabsTrigger>
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

          <TabsContent value="toast_api" className="space-y-3">
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
              <Label>Client ID</Label>
              <Input value={toastClientId} onChange={(e) => setToastClientId(e.target.value)} placeholder="Toast API client ID" className="mt-1" />
            </div>
            <div>
              <Label>Client Secret</Label>
              <Input type="password" value={toastClientSecret} onChange={(e) => setToastClientSecret(e.target.value)} placeholder="Toast API client secret" className="mt-1" />
            </div>
            <div>
              <Label>Restaurant GUID</Label>
              <Input value={toastRestaurantGuid} onChange={(e) => setToastRestaurantGuid(e.target.value)} placeholder="e.g. 12345678-aaaa-bbbb-cccc-1234567890ab" className="mt-1" />
              <p className="text-xs text-muted-foreground mt-1">
                Find this in Toast Web under Restaurant Admin → Restaurant Info, or ask your Toast partner contact. Sent as the <code>Toast-Restaurant-External-ID</code> header.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={!toastClientId || !toastClientSecret || !toastRestaurantGuid || loading}
            >
              {loading ? "Saving…" : "Save"}
            </Button>
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

      <div className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)] mt-8">
        <h2 className="font-semibold mb-1">Signage publishing (Firebase)</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Send rendered images to your Firebase signage app via your external renderer service.
          The renderer handles Firebase Storage upload and Firestore updates — your service account stays on the renderer, never in this app.
        </p>

        <div className="space-y-3">
          <div>
            <Label>Company ID</Label>
            <Input
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              placeholder="e.g. pasta-mista-towson"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used in Firebase paths: <code>rendered/{`{companyId}`}/{`{templateId}`}/latest.png</code>. Must be stable.
            </p>
          </div>
          <div>
            <Label>Renderer URL</Label>
            <Input
              value={rendererUrl}
              onChange={(e) => setRendererUrl(e.target.value)}
              placeholder="https://renderer-xxxx.run.app"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Public URL of your Puppeteer renderer service. Must expose <code>POST /render</code> and <code>GET /health</code>.
            </p>
          </div>
          <div>
            <Label>Renderer auth token (optional)</Label>
            <Input
              type="password"
              value={rendererToken}
              onChange={(e) => setRendererToken(e.target.value)}
              placeholder="Bearer token shared with the renderer"
              className="mt-1"
            />
          </div>
          <div className="flex items-center justify-between gap-4 pt-2">
            <div>
              <Label className="text-base">Auto-publish on price change</Label>
              <p className="text-sm text-muted-foreground mt-1">
                When sync detects a price change, automatically render and push the image to Firebase.
              </p>
            </div>
            <Switch checked={autoPublish} onCheckedChange={setAutoPublish} />
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={handleSaveSignage} disabled={!companyId.trim() || !rendererUrl.trim() || signageSaving}>
              {signageSaving ? "Saving…" : "Save signage settings"}
            </Button>
            <Button variant="outline" onClick={handleTestRenderer} disabled={!rendererUrl.trim() || signageTesting}>
              {signageTesting ? "Testing…" : "Test renderer"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}