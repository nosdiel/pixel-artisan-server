/**
 * Firebase web client for the Lovable signage editor.
 *
 * Reads config from VITE_FIREBASE_* env vars (publishable values — safe in
 * the client bundle). Add these to your Lovable Workspace Build Secrets so
 * Vite can inline them at build time:
 *
 *   VITE_FIREBASE_API_KEY
 *   VITE_FIREBASE_AUTH_DOMAIN          (e.g. nini-signage-renderer.firebaseapp.com)
 *   VITE_FIREBASE_PROJECT_ID           (nini-signage-renderer)
 *   VITE_FIREBASE_STORAGE_BUCKET       (nini-signage-renderer.firebasestorage.app)
 *   VITE_FIREBASE_APP_ID
 *   VITE_FIREBASE_MESSAGING_SENDER_ID  (optional)
 *
 * If any required value is missing, getFirebase() returns null and callers
 * MUST degrade gracefully (the editor stays usable without Square sync).
 */

import { initializeApp, type FirebaseApp, getApps } from "firebase/app";
import { getAuth, signInAnonymously, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, type Functions } from "firebase/functions";

type FirebaseBundle = {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
};

let bundle: FirebaseBundle | null = null;
let initError: string | null = null;

function readConfig() {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const cfg = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    appId: env.VITE_FIREBASE_APP_ID,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  };
  const missing = (["apiKey", "authDomain", "projectId", "appId"] as const).filter((k) => !cfg[k]);
  if (missing.length) {
    initError = `Firebase web config missing: ${missing.map((k) => `VITE_FIREBASE_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}`).join(", ")}`;
    return null;
  }
  return cfg as Record<string, string>;
}

export function getFirebase(): FirebaseBundle | null {
  if (bundle) return bundle;
  if (typeof window === "undefined") return null; // SSR-safe no-op
  const cfg = readConfig();
  if (!cfg) return null;
  const app = getApps()[0] ?? initializeApp(cfg);
  bundle = {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
    functions: getFunctions(app, "us-central1"),
  };
  return bundle;
}

export function getFirebaseInitError(): string | null {
  return initError;
}

/** Ensure the Firebase user is signed in so Firestore rules pass. */
export async function ensureFirebaseAuth(): Promise<string | null> {
  const fb = getFirebase();
  if (!fb) return null;
  if (fb.auth.currentUser) return fb.auth.currentUser.uid;
  const cred = await signInAnonymously(fb.auth);
  return cred.user.uid;
}