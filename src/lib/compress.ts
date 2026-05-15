import imageCompression from "browser-image-compression";

export type CompressedVariant = {
  format: "webp" | "jpeg";
  blob: Blob;
  size: number;
  quality: number;
};

export async function autoCompress(file: File | Blob): Promise<{
  best: CompressedVariant;
  variants: CompressedVariant[];
  originalSize: number;
  width: number;
  height: number;
}> {
  const originalSize = file.size;
  const img = await loadImage(file);
  const { width, height } = img;

  const targets: { format: "webp" | "jpeg"; quality: number }[] = [
    { format: "webp", quality: 0.82 },
    { format: "jpeg", quality: 0.85 },
  ];
  const variants: CompressedVariant[] = [];
  for (const t of targets) {
    const blob = await imageCompression(file as File, {
      maxSizeMB: 5,
      useWebWorker: true,
      fileType: t.format === "webp" ? "image/webp" : "image/jpeg",
      initialQuality: t.quality,
    });
    variants.push({ format: t.format, blob, size: blob.size, quality: t.quality });
  }
  const best = variants.slice().sort((a, b) => a.size - b.size)[0];
  return { best, variants, originalSize, width, height };
}

function loadImage(file: File | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}