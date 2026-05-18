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

export function useSquareCatalog() {
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
      const q = query(collection(fb.db, "square_items"), orderBy("name"));
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
  }, []);

  return { items, loading, error };
}

export function useSquareSyncState() {
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
      unsub = onSnapshot(
        doc(fb.db, "square_sync_state", "global"),
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
  }, []);

  return { state, error };
}

export function useTriggerSquareSync() {
  const [running, setRunning] = useState(false);
  const trigger = useCallback(async () => {
    const fb = getFirebase();
    if (!fb) throw new Error(getFirebaseInitError() ?? "Firebase not configured");
    await ensureFirebaseAuth();
    setRunning(true);
    try {
      const callable = httpsCallable(fb.functions, "syncSquareCatalog");
      const res = await callable({});
      return res.data as { ok: boolean; itemCount: number; pages: number };
    } finally {
      setRunning(false);
    }
  }, []);
  return { trigger, running };
}