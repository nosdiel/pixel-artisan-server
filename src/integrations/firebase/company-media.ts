/**
 * External-launch (Nini Signage Renderer) media uploads.
 *
 * When the editor is opened with ?template=...&companyId=... it bypasses
 * Lovable/Supabase auth entirely and writes media directly to the customer
 * Firebase project under:
 *
 *   Storage:   rendered/{companyId}/{templateId}/{mediaId}.{ext}
 *   Firestore: companies/{companyId}/media/{mediaId}
 *
 * Storage objects always carry `customMetadata.mediaDocId` and
 * `customMetadata.companyMediaId` so the compressor / renderer Cloud
 * Function can locate and mirror the matching company media doc.
 */
import {
  doc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";
import { ensureFirebaseAuth, getFirebase, getFirebaseInitError } from "./client";

export type CompanyMediaKind = "image" | "video";

export type UploadCompanyMediaInput = {
  companyId: string;
  templateId: string;
  kind: CompanyMediaKind;
  blob: Blob;
  contentType: string;
  name?: string;
  thumbnailBlob?: Blob | null;
  thumbnailContentType?: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  /** Optional explicit mediaId; otherwise a stable one is generated. */
  mediaId?: string;
};

export type UploadCompanyMediaResult = {
  mediaDocId: string;
  path: string;
  url: string;
  thumbnailPath: string | null;
  thumbnailURL: string | null;
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

function makeId(): string {
  // 20-char URL-safe id; avoids extra deps.
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

export async function uploadCompanyMedia(
  input: UploadCompanyMediaInput,
): Promise<UploadCompanyMediaResult> {
  const fb = getFirebase();
  if (!fb) throw new Error(getFirebaseInitError() ?? "Firebase is not configured");
  await ensureFirebaseAuth();

  const storage = getStorage(fb.app);
  const mediaId = input.mediaId ?? makeId();
  const ext = extFor(input.contentType, input.kind === "video" ? "mp4" : "png");
  const path = `rendered/${input.companyId}/${input.templateId}/${mediaId}.${ext}`;

  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, input.blob, {
    contentType: input.contentType,
    customMetadata: {
      mediaDocId: mediaId,
      companyId: input.companyId,
      companyMediaId: mediaId,
      templateId: input.templateId,
      source: "lovable-editor-external",
    },
  });
  const url = await getDownloadURL(fileRef);

  let thumbnailPath: string | null = null;
  let thumbnailURL: string | null = null;
  if (input.kind === "video" && input.thumbnailBlob) {
    const thumbType = input.thumbnailContentType ?? "image/jpeg";
    thumbnailPath = `rendered/${input.companyId}/${input.templateId}/${mediaId}.thumb.${extFor(thumbType, "jpg")}`;
    const thumbRef = ref(storage, thumbnailPath);
    await uploadBytes(thumbRef, input.thumbnailBlob, {
      contentType: thumbType,
      customMetadata: {
        mediaDocId: mediaId,
        companyId: input.companyId,
        companyMediaId: mediaId,
        templateId: input.templateId,
        kind: "thumbnail",
      },
    });
    thumbnailURL = await getDownloadURL(thumbRef);
  }

  await setDoc(
    doc(fb.db, "companies", input.companyId, "media", mediaId),
    {
      id: mediaId,
      templateId: input.templateId,
      companyId: input.companyId,
      type: input.kind,
      name: input.name ?? null,
      url,
      path,
      thumbnailURL,
      thumbnailPath,
      contentType: input.contentType,
      size: input.blob.size,
      width: input.width ?? null,
      height: input.height ?? null,
      length: input.durationSeconds ?? null,
      status: "ready",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  return { mediaDocId: mediaId, path, url, thumbnailPath, thumbnailURL };
}

export function redirectToReturnUrl(
  returnUrl: string,
  params: { mediaDocId: string; url: string; thumbnailURL?: string | null },
): void {
  try {
    const u = new URL(returnUrl, window.location.origin);
    u.searchParams.set("mediaDocId", params.mediaDocId);
    u.searchParams.set("url", params.url);
    if (params.thumbnailURL) u.searchParams.set("thumbnailURL", params.thumbnailURL);
    window.location.href = u.toString();
  } catch {
    // ignore — invalid returnUrl, caller will see the toast
  }
}