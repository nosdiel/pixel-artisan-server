import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const [token, setToken] = useState("");
  const [env, setEnv] = useState("production");
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("square_connections").select("merchant_id, environment").maybeSingle();
      if (data) { setConnected(true); setEnv(data.environment); }
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
      </div>
      <p className="text-xs text-muted-foreground mt-4">API keys for the public signage API will be available here in the next iteration.</p>
    </div>
  );
}