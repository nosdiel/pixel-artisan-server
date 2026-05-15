import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncUserCatalog } from "@/lib/square-sync.server";

export const Route = createFileRoute("/api/public/hooks/sync-square")({
  server: {
    handlers: {
      POST: async () => {
        const { data: connections, error } = await supabaseAdmin
          .from("square_connections")
          .select("user_id, source, access_token, environment, site_url")
          .eq("auto_sync_enabled", true);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }

        const results: Array<{ user_id: string; ok: boolean; itemCount?: number; staleCount?: number; error?: string }> = [];
        for (const c of connections ?? []) {
          try {
            const r = await syncUserCatalog(c.user_id, {
              source: c.source,
              access_token: c.access_token,
              environment: c.environment,
              site_url: c.site_url,
            });
            results.push({ user_id: c.user_id, ok: true, ...r });
          } catch (e) {
            results.push({ user_id: c.user_id, ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }

        return new Response(
          JSON.stringify({ ranAt: new Date().toISOString(), count: results.length, results }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});