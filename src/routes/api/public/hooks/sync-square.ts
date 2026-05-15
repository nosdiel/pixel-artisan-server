import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncUserCatalog } from "@/lib/square-sync.server";

export const Route = createFileRoute("/api/public/hooks/sync-square")({
  server: {
    handlers: {
      POST: async () => {
        const { data: connections, error } = await supabaseAdmin
          .from("square_connections")
          .select("user_id, access_token, environment")
          .eq("auto_sync_enabled", true);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }

        const results: Array<{ user_id: string; ok: boolean; itemCount?: number; staleCount?: number; error?: string }> = [];
        for (const c of connections ?? []) {
          try {
            const r = await syncUserCatalog(c.user_id, c.access_token, c.environment);
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