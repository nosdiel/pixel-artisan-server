import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const [token, setToken] = useState("");
  const [env, setEnv] = useState("production");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [autoSync, setAutoSync] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("square_connections")
        .select("merchant_id, environment, auto_sync_enabled, last_sync_at")
        .maybeSingle();
      if (data) {
        setConnected(true);
        setEnv(data.environment);
        setAutoSync(!!data.auto_sync_enabled);
        setLastSync(data.last_sync_at);
      }
    })();
  }, []);

  const save = async () => {
    setLoading(true);
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("square_connections").upsert({
      user_id: u.user!.id, access_token: token, environment: env,
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Square connected");
    setConnected(true); setToken("");
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
        <p className="text-sm text-muted-foreground mb-4">{connected ? "Square is connected. Replace the token below to update." : "Paste a Square Personal Access Token to enable price-driven templates."}</p>
        <div className="space-y-3">
          <div><Label>Environment</Label>
            <select value={env} onChange={(e) => setEnv(e.target.value)} className="mt-1 w-full h-10 px-3 rounded-md border border-input bg-background text-sm">
              <option value="production">Production</option><option value="sandbox">Sandbox</option>
            </select>
          </div>
          <div><Label>Access Token</Label><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAAAlxxxxxxx" className="mt-1" /></div>
          <Button onClick={save} disabled={!token || loading}>{loading ? "Saving…" : "Save"}</Button>
        </div>
        {connected && (
          <div className="mt-6 pt-6 border-t border-border flex items-start justify-between gap-4">
            <div>
              <Label className="text-base">Automatic catalog sync</Label>
              <p className="text-sm text-muted-foreground mt-1">Refresh Square prices every hour and flag stale templates automatically.</p>
              {lastSync && <p className="text-xs text-muted-foreground mt-1">Last sync: {new Date(lastSync).toLocaleString()}</p>}
            </div>
            <Switch checked={autoSync} onCheckedChange={toggleAuto} />
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-4">API keys for the public signage API will be available here in the next iteration.</p>
    </div>
  );
}