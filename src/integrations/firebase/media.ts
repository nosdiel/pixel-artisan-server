/**
 * Upload edited media directly to Firebase Storage and create/update the
 * Firestore media/{mediaDocId} document. The Cloud Function `onMediaUploaded`
 * picks up the upload via Storage trigger (using the `mediaDocId` carried in
 * customMetadata) and fills in width/height/length/processed url.
 *
 * This is the production path used by the signage app. Supabase is no longer
 * used for working media.
 */

import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";
import { ensureFirebaseAuth, getFirebase, getFirebaseInitError } from "./client";

export type MediaKind = "image" | "video";

export type UploadEditedMediaInput = {
  kind: MediaKind;
  /** Final media bytes (already trimmed/edited). */
  blob: Blob;
  /** MIME type, e.g. "video/mp4", "image/jpeg". */
  contentType: string;
  /** Optional video-only inputs. */
  thumbnailBlob?: Blob | null;
  thumbnailContentType?: string;
  /** Optional client-known dimensions / duration. The Cloud Function will
   *  authoritatively overwrite these after processing. */
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  /** Display name shown in libraries. */
  name?: string;
};

export type UploadEditedMediaResult = {
  mediaDocId: string;
  path: string;
  url: string;
  thumbnailPath: string | null;
  thumbnailURL: string | null;
};

export type FirebaseMediaDoc = {
  id: string;
  status?: string;
  url?: string;
  path?: string;
  thumbnailURL?: string | null;
  thumbnailPath?: string | null;
  width?: number | null;
  height?: number | null;
  length?: number | null;
  size?: number | null;
  type?: string;
  contentType?: string;
  [k: string]: unknown;
};

function extFor(contentType: string, fallback: string): string {
  if (contentType === "video/mp4") return "mp4";
  if (contentType === "video/webm") return "webm";
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return fallback;
}

/**
 * 1) Create empty Firestore doc to get a stable mediaDocId.
 * 2) Upload the file to Storage with customMetadata.mediaDocId so the
 *    Storage-trigger Cloud Function can locate the right doc.
 * 3) (Video) upload thumbnail.
 * 4) Write url/path/thumbnailURL/thumbnailPath/size/type back to the doc.
 *
 * The Cloud Function will later overwrite/augment with width, height, length.
 */
export async function uploadEditedMediaToFirebase(
  input: UploadEditedMediaInput,
): Promise<UploadEditedMediaResult> {
  const fb = getFirebase();
  if (!fb) {
    throw new Error(getFirebaseInitError() ?? "Firebase is not configured");
  }
  const uid = await ensureFirebaseAuth();
  if (!uid) throw new Error("Firebase auth failed");

  const storage = getStorage(fb.app);
  const mediaCol = collection(fb.db, "media");

  // 1. Create the Firestore doc up-front so we have a stable id.
  const mediaRef = await addDoc(mediaCol, {
    ownerUid: uid,
    type: input.kind === "video" ? "video" : "image",
    name: input.name ?? null,
    status: "processing",
    creationDate: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    width: input.width ?? null,
    height: input.height ?? null,
    length: input.durationSeconds ?? null,
    size: input.blob.size,
    contentType: input.contentType,
  });
  const mediaDocId = mediaRef.id;

  const ext = extFor(input.contentType, input.kind === "video" ? "mp4" : "bin");
  const folder = input.kind === "video" ? "videos" : "images";
  const path = `users/${uid}/${folder}/${mediaDocId}.${ext}`;

  // 2. Upload the main asset. customMetadata.mediaDocId lets the Storage
  //    trigger know which Firestore doc to update after compression.
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, input.blob, {
    contentType: input.contentType,
    customMetadata: { mediaDocId, ownerUid: uid, source: "lovable-editor" },
  });
  const url = await getDownloadURL(fileRef);

  // 3. Upload thumbnail for videos.
  let thumbnailPath: string | null = null;
  let thumbnailURL: string | null = null;
  if (input.kind === "video" && input.thumbnailBlob) {
    const thumbType = input.thumbnailContentType ?? "image/jpeg";
    const thumbExt = extFor(thumbType, "jpg");
    thumbnailPath = `users/${uid}/thumbnails/${mediaDocId}.${thumbExt}`;
    const thumbRef = ref(storage, thumbnailPath);
    await uploadBytes(thumbRef, input.thumbnailBlob, {
      contentType: thumbType,
      customMetadata: { mediaDocId, ownerUid: uid, kind: "thumbnail" },
    });
    thumbnailURL = await getDownloadURL(thumbRef);
  }

  // 4. Update doc with the upload result. Width/height/length may be
  //    refined later by the Cloud Function processor, which also flips
  //    status from "processing" to "ready" once compression + thumbnail
  //    generation completes.
  await updateDoc(doc(fb.db, "media", mediaDocId), {
    url,
    path,
    thumbnailURL,
    thumbnailPath,
    size: input.blob.size,
    type: input.kind === "video" ? "video" : "image",
    contentType: input.contentType,
    status: "processing",
    updatedAt: serverTimestamp(),
  });

  return { mediaDocId, path, url, thumbnailPath, thumbnailURL };
}

/**
 * Subscribe to media/{mediaDocId} and resolve with the final document once
 * the deployed Cloud Function flips `status` to `"ready"`. Rejects on
 * `status === "error"` or after the timeout.
 */
export function waitForMediaReady(
  mediaDocId: string,
  opts: { timeoutMs?: number; onUpdate?: (doc: FirebaseMediaDoc) => void } = {},
): Promise<FirebaseMediaDoc> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const fb = getFirebase();
    if (!fb) {
      reject(new Error(getFirebaseInitError() ?? "Firebase is not configured"));
      return;
    }
    const ref = doc(fb.db, "media", mediaDocId);
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for media ${mediaDocId} to be ready`));
    }, timeoutMs);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) return;
        const data = { id: snap.id, ...(snap.data() as Record<string, unknown>) } as FirebaseMediaDoc;
        opts.onUpdate?.(data);
        if (data.status === "ready") {
          clearTimeout(timer);
          unsub();
          resolve(data);
        } else if (data.status === "error") {
          clearTimeout(timer);
          unsub();
          reject(new Error((data.error as string) || "Cloud Function reported error"));
        }
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Helper: also writes the same fields with setDoc(..., { merge: true }) so
 * downstream code can update an existing media doc without re-uploading.
 */
export async function patchMediaDoc(
  mediaDocId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const fb = getFirebase();
  if (!fb) throw new Error(getFirebaseInitError() ?? "Firebase is not configured");
  await ensureFirebaseAuth();
  await setDoc(
    doc(fb.db, "media", mediaDocId),
    { ...fields, updatedAt: serverTimestamp() },
    { merge: true },
  );
}