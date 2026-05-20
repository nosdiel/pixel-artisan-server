import { useEffect, useState, useCallback } from "react";
import { collection, doc, onSnapshot, query, orderBy } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { ensureFirebaseAuth, getFirebase, getFirebaseInitError } from "@/integrations/firebase/client";
import type { SquareItem } from "@/lib/square-binding";

export type SquareSyncState = {
  lastStatus?: "ok" | "error" | "running" | null;
  lastError?: string | null;
  lastFullSyncAt?: { seconds: number } | null;
  itemCount?: number | null;
  runningSince?: { seconds: number } | null;
};

type SquareItemRow = SquareItem & { id: string };

/**
 * Subscribe to Square catalog items.
 *
 * - When `companyId` is provided (Nini Renderer external launch), read from
 *   `companies/{companyId}/square_items`. This is the source of truth for
 *   that customer; the global Square URL lives at `companies/{companyId}`
 *   in `squareMenuUrl` and is configured inside Nini Renderer.
 * - Otherwise fall back to the legacy global `square_items` collection.
 */
export function useSquareCatalog(companyId?: string | null) {
  const [items, setItems] = useState<SquareItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fb = getFirebase();
      if (!fb) {
        setLoading(false);
        setError(getFirebaseInitError() ?? "Firebase not configured");
        return;
      }
      try {
        await ensureFirebaseAuth();
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          setError(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      const itemsCol = companyId
        ? collection(fb.db, "companies", companyId, "square_items")
        : collection(fb.db, "square_items");
      const q = query(itemsCol, orderBy("name"));
      unsub = onSnapshot(
        q,
        (snap) => {
          const rows: SquareItemRow[] = [];
          snap.forEach((d) => {
            const data = d.data() as SquareItem;
            if (data?.isDeleted) return;
            rows.push({ id: d.id, ...data });
          });
          setItems(rows);
          setLoading(false);
          setError(null);
        },
        (err) => {
          setLoading(false);
          setError(err.message);
        },
      );
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [companyId]);

  return { items, loading, error };
}

export function useSquareSyncState(companyId?: string | null) {
  const [state, setState] = useState<SquareSyncState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fb = getFirebase();
      if (!fb) {
        setError(getFirebaseInitError() ?? "Firebase not configured");
        return;
      }
      try {
        await ensureFirebaseAuth();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        return;
      }
      const stateRef = companyId
        ? doc(fb.db, "companies", companyId, "square_sync_state", "global")
        : doc(fb.db, "square_sync_state", "global");
      unsub = onSnapshot(
        stateRef,
        (snap) => {
          setState((snap.data() as SquareSyncState) || {});
          setError(null);
        },
        (err) => setError(err.message),
      );
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [companyId]);

  return { state, error };
}

export function useTriggerSquareSync(companyId?: string | null) {
  const [running, setRunning] = useState(false);
  const trigger = useCallback(async () => {
    const fb = getFirebase();
    if (!fb) throw new Error(getFirebaseInitError() ?? "Firebase not configured");
    await ensureFirebaseAuth();
    setRunning(true);
    try {
      const callable = httpsCallable(fb.functions, "syncSquareCatalog");
      // Nini Renderer's Cloud Function reads the menu URL from
      // companies/{companyId}.squareMenuUrl when companyId is provided.
      const res = await callable(companyId ? { companyId } : {});
      return res.data as { ok: boolean; itemCount: number; pages: number };
    } finally {
      setRunning(false);
    }
  }, [companyId]);
  return { trigger, running };
}

export type CompanySettings = {
  squareMenuUrl?: string | null;
  name?: string | null;
  [k: string]: unknown;
};

/**
 * Subscribe to `companies/{companyId}` and surface the Square/menu URL the
 * customer configured in Nini Renderer. This replaces the legacy
 * `square_connections.site_url` field that lived in Supabase.
 */
export function useCompanySettings(companyId?: string | null) {
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) {
      setSettings(null);
      return;
    }
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fb = getFirebase();
      if (!fb) {
        setError(getFirebaseInitError() ?? "Firebase not configured");
        return;
      }
      try {
        await ensureFirebaseAuth();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        return;
      }
      unsub = onSnapshot(
        doc(fb.db, "companies", companyId),
        (snap) => {
          setSettings((snap.data() as CompanySettings) ?? null);
          setError(null);
        },
        (err) => setError(err.message),
      );
    })();
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [companyId]);

  return { settings, squareMenuUrl: settings?.squareMenuUrl ?? null, error };
}