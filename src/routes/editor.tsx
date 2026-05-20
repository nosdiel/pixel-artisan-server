import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Fabric from "fabric";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { supabase } from "@/integrations/supabase/client";
import { autoCompress } from "@/lib/compress";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { VideoEditorDialog, type EditedVideoResult } from "@/components/VideoEditorDialog";
import { useSquareCatalog, useSquareSyncState, useTriggerSquareSync } from "@/lib/useSquare";
import { uploadEditedMediaToFirebase, waitForMediaReady } from "@/integrations/firebase/media";
import {
  Upload, Type, Square as SquareIcon, Circle as CircleIcon, Triangle as TriangleIcon,
  RotateCw, FlipHorizontal, FlipVertical, Save, Trash2, Copy,
  ArrowUp, ArrowDown, Undo2, Redo2, ZoomIn, ZoomOut, Maximize2,
  Image as ImageIcon, Layers, Eye, EyeOff, Bold, Italic, Underline,
  AlignLeft, AlignCenter, AlignRight, Plus, Tag, RefreshCw, Video as VideoIcon,
} from "lucide-react";

const PRESETS: Record<string, { w: number; h: number; label: string }> = {
  "1920x1080": { w: 1920, h: 1080, label: "1080p Landscape" },
  "3840x2160": { w: 3840, h: 2160, label: "4K Landscape" },
  "1080x1920": { w: 1080, h: 1920, label: "1080p Portrait" },
  "2160x3840": { w: 2160, h: 3840, label: "4K Portrait" },
  "1280x720":  { w: 1280, h: 720,  label: "720p Landscape" },
  "1080x1080": { w: 1080, h: 1080, label: "Square 1:1" },
};

const FONTS = ["Inter", "Arial", "Georgia", "Times New Roman", "Courier New", "Impact", "Comic Sans MS", "Verdana"];
const SWATCHES = ["#000000", "#ffffff", "#ef4444", "#f97316", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];

type Asset = { id: string; title: string; url: string; path: string };
type PendingBaseImage = { url: string; path: string };
type GalleryImageRow = { id: string; title: string; preset: string | null; width: number; height: number; variants: Array<{ path: string; format: string }> | null };
type FabricModule = typeof import("fabric");
type SquareCacheItem = { square_item_id: string; name: string | null; description: string | null; price_cents: number | null; currency: string | null };
type SquareField = "price" | "name" | "description";
type SquareBinding = { itemId: string; field: SquareField };

function getCanvasSize(presetKey: string) {
  return PRESETS[presetKey] ?? PRESETS["1920x1080"];
}

function applyCanvasDisplayZoom(canvas: Fabric.Canvas, width: number, height: number, displayZoom: number) {
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setDimensions({ width, height }, { backstoreOnly: true });
  canvas.setDimensions({ width: width * displayZoom, height: height * displayZoom }, { cssOnly: true });
  canvas.requestRenderAll();
}

function formatSquareValue(item: SquareCacheItem | undefined, field: SquareField): string {
  if (!item) return "";
  if (field === "name") return item.name ?? "";
  if (field === "description") return item.description ?? "";
  if (item.price_cents == null) return "";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: item.currency || "USD" }).format(item.price_cents / 100);
}

function extractStoragePath(src: string) {
  try {
    const url = new URL(src);
    const markers = ["/storage/v1/object/sign/images/", "/storage/v1/object/public/images/"];
    const marker = markers.find((m) => url.pathname.includes(m));
    if (!marker) return null;
    return decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  } catch {
    return null;
  }
}

const TRANSPARENT_VIDEO_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const VIDEO_STORAGE_EXT_RE = /\.(mp4|mov|m4v|webm|ogg|ogv)(?:$|[?#])/i;

function isVideoStoragePath(path: string) {
  return VIDEO_STORAGE_EXT_RE.test(path);
}

function getFabricObjectSrc(obj: any): string | null {
  const direct = typeof obj?.src === "string" ? obj.src : null;
  const fromGetter = typeof obj?.getSrc === "function" ? obj.getSrc() : null;
  const el = typeof obj?.getElement === "function" ? obj.getElement() : null;
  const fromElement = el instanceof HTMLVideoElement || el instanceof HTMLImageElement ? el.currentSrc || el.src : null;
  return direct || fromGetter || fromElement || null;
}

function patchSerializedMedia(serializedObjects: any[] | undefined, liveObjects: any[] | undefined) {
  if (!Array.isArray(serializedObjects) || !Array.isArray(liveObjects)) return;
  serializedObjects.forEach((serialized, index) => {
    const live = liveObjects[index];
    if (!serialized || !live) return;
    const src = getFabricObjectSrc(live) || (typeof serialized.src === "string" ? serialized.src : null);
    const storedVideoPath = typeof live.videoStoragePath === "string" ? live.videoStoragePath : null;
    const extractedPath = src ? extractStoragePath(src) : null;
    const videoPath = storedVideoPath || (extractedPath && isVideoStoragePath(extractedPath) ? extractedPath : null);
    if (videoPath) {
      serialized.videoStoragePath = videoPath;
      delete serialized.imageStoragePath;
      serialized.src = TRANSPARENT_VIDEO_PLACEHOLDER;
      serialized.crossOrigin = "anonymous";
    }
    patchSerializedMedia(serialized.objects ?? serialized._objects, live.getObjects?.() ?? live._objects);
  });
}

function presetForImage(width: number, height: number) {
  const exact = Object.entries(PRESETS).find(([, size]) => size.w === width && size.h === height)?.[0];
  if (exact) return exact;
  if (Math.abs(width - height) < Math.max(width, height) * 0.08) return "1080x1080";
  return height > width ? "1080x1920" : "1920x1080";
}

export const Route = createFileRoute("/editor")({
  component: EditorPage,
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    template: typeof s.template === "string" ? s.template : undefined,
    image: typeof s.image === "string" ? s.image : undefined,
    companyId: typeof s.companyId === "string" ? s.companyId : undefined,
  }),
});

function EditorPage() {
  const { template: templateIdParam, image: imageIdParam } = Route.useSearch();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const fcRef = useRef<Fabric.Canvas | null>(null);
  const historyRef = useRef<{ stack: string[]; index: number; suspend: boolean }>({ stack: [], index: -1, suspend: false });
  const [fabric, setFabric] = useState<FabricModule | null>(null);
  const [preset, setPreset] = useState("1920x1080");
  const [title, setTitle] = useState("Untitled");
  const [bgColor, setBgColor] = useState("#ffffff");
  const [zoom, setZoom] = useState(0.4);
  const [active, setActive] = useState<Fabric.Object | null>(null);
  const [, forceUpdate] = useState(0);
  const refresh = useCallback(() => forceUpdate((n) => n + 1), []);
  const [saving, setSaving] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(templateIdParam ?? null);
  const [pendingCanvasJson, setPendingCanvasJson] = useState<unknown | null>(null);
  const [pendingBaseImage, setPendingBaseImage] = useState<PendingBaseImage | null>(null);
  const [customFonts, setCustomFonts] = useState<string[]>([]);
  const [uploadingFont, setUploadingFont] = useState(false);
  const [pendingVideoFile, setPendingVideoFile] = useState<File | null>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const [squareItems, setSquareItems] = useState<SquareCacheItem[]>([]);
  const navigate = useNavigate();

  const getFitZoom = useCallback((presetKey = preset) => {
    const host = canvasHostRef.current;
    const { w, h } = getCanvasSize(presetKey);
    if (!host) return Math.min(0.4, 720 / h, 900 / w);
    const availableWidth = Math.max(host.clientWidth - 64, 320);
    const availableHeight = Math.max(host.clientHeight - 64, 320);
    return Math.max(0.1, Math.min(availableWidth / w, availableHeight / h, 1));
  }, [preset]);

  const withFreshImageUrls = useCallback(async (canvasJson: unknown) => {
    const json = JSON.parse(JSON.stringify(canvasJson)) as Record<string, any>;
    const refreshObject = async (obj: any): Promise<void> => {
      if (!obj || typeof obj !== "object") return;
      const srcPath = typeof obj.src === "string" ? extractStoragePath(obj.src) : null;
      const videoPath = typeof obj.videoStoragePath === "string" ? obj.videoStoragePath : (srcPath && isVideoStoragePath(srcPath) ? srcPath : null);
      if (videoPath) {
        const { data } = await supabase.storage.from("images").createSignedUrl(videoPath, 3600);
        if (data?.signedUrl) {
          obj.videoSrc = data.signedUrl;
          obj.src = TRANSPARENT_VIDEO_PLACEHOLDER;
          obj.crossOrigin = "anonymous";
          obj.videoStoragePath = videoPath;
        }
      }
      const path = !videoPath ? (typeof obj.imageStoragePath === "string" ? obj.imageStoragePath : srcPath) : null;
      if (path) {
        const { data } = await supabase.storage.from("images").createSignedUrl(path, 3600);
        if (data?.signedUrl) {
          obj.src = data.signedUrl;
          obj.crossOrigin = "anonymous";
          obj.imageStoragePath = path;
        }
      }
      await Promise.all(((obj.objects ?? obj._objects ?? []) as any[]).map(refreshObject));
      if (obj.clipPath) await refreshObject(obj.clipPath);
    };
    await Promise.all(((json.objects ?? []) as any[]).map(refreshObject));
    if (json.backgroundImage) await refreshObject(json.backgroundImage);
    return json;
  }, []);

  const loadGalleryImageAsTemplate = useCallback(async (imageId: string) => {
    const { data, error } = await supabase
      .from("images")
      .select("id, title, preset, width, height, variants")
      .eq("id", imageId)
      .maybeSingle();
    if (error || !data) {
      toast.error("Could not load image");
      return;
    }
    const image = data as GalleryImageRow;
    setTitle(image.title || "Untitled");
    setPreset(image.preset && PRESETS[image.preset] ? image.preset : presetForImage(image.width, image.height));
    const variant = image.variants?.[0];
    if (!variant?.path) {
      toast.error("This image has no stored file to reuse");
      return;
    }
    const { data: signed, error: signError } = await supabase.storage.from("images").createSignedUrl(variant.path, 3600);
    if (signError || !signed?.signedUrl) {
      toast.error("Could not prepare image for editing");
      return;
    }
    setTemplateId(null);
    setPendingCanvasJson(null);
    setPendingBaseImage({ url: signed.signedUrl, path: variant.path });
  }, []);

  useEffect(() => {
    let mounted = true;
    void import("fabric").then((mod) => {
      if (mounted) setFabric(mod);
    });
    return () => { mounted = false; };
  }, []);

  // Load template metadata BEFORE canvas init so preset matches
  useEffect(() => {
    if (!templateIdParam) return;
    (async () => {
      const { data, error } = await supabase
        .from("templates")
        .select("id, name, preset, canvas_json")
        .eq("id", templateIdParam)
        .maybeSingle();
      if (error || !data) {
        if (imageIdParam) {
          await loadGalleryImageAsTemplate(imageIdParam);
        } else {
          toast.error("Could not load template");
        }
        return;
      }
      setTemplateId(data.id);
      setTitle(data.name || "Untitled");
      if (data.preset && PRESETS[data.preset]) setPreset(data.preset);
      const cj = data.canvas_json as { background?: string } | null;
      if (cj && typeof cj === "object" && typeof cj.background === "string") {
        setBgColor(cj.background);
      }
      setPendingCanvasJson(data.canvas_json ? await withFreshImageUrls(data.canvas_json) : null);
    })();
  }, [templateIdParam, imageIdParam, loadGalleryImageAsTemplate, withFreshImageUrls]);

  // Fall back to the rendered gallery image when the row has no editable template yet
  useEffect(() => {
    if (!imageIdParam || templateIdParam) return;
    void loadGalleryImageAsTemplate(imageIdParam);
  }, [imageIdParam, templateIdParam, loadGalleryImageAsTemplate]);

  // Initialize canvas
  useEffect(() => {
    if (!fabric || !canvasRef.current) return;
    const { w, h } = getCanvasSize(preset);
    const fc = new fabric.Canvas(canvasRef.current, { width: w, height: h, backgroundColor: bgColor, preserveObjectStacking: true });
    fcRef.current = fc;
    const fittedZoom = getFitZoom(preset);
    applyCanvasDisplayZoom(fc, w, h, fittedZoom);
    setZoom(fittedZoom);

    const onSel = () => { setActive(fc.getActiveObject() ?? null); refresh(); };
    const onMod = () => { pushHistory(); refresh(); };
    fc.on("selection:created", onSel);
    fc.on("selection:updated", onSel);
    fc.on("selection:cleared", onSel);
    fc.on("object:modified", onMod);
    fc.on("object:added", onMod);
    fc.on("object:removed", onMod);

    pushHistory();
    return () => { fc.dispose(); fcRef.current = null; historyRef.current = { stack: [], index: -1, suspend: false }; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fabric, preset, getFitZoom]);

  // Smart alignment guides while dragging
  useEffect(() => {
    const fc = fcRef.current;
    if (!fc || !fabric) return;
    const SNAP = 6;
    let guides: Array<{ o: "h" | "v"; pos: number }> = [];

    const drawGuides = () => {
      const ctx = (fc as any).contextTop as CanvasRenderingContext2D;
      const z = fc.getZoom();
      ctx.save();
      ctx.clearRect(0, 0, fc.width!, fc.height!);
      ctx.strokeStyle = "#ec4899";
      ctx.lineWidth = 1;
      for (const g of guides) {
        ctx.beginPath();
        if (g.o === "v") { ctx.moveTo(g.pos * z, 0); ctx.lineTo(g.pos * z, fc.height!); }
        else { ctx.moveTo(0, g.pos * z); ctx.lineTo(fc.width!, g.pos * z); }
        ctx.stroke();
      }
      ctx.restore();
    };
    const clearGuides = () => {
      guides = [];
      const ctx = (fc as any).contextTop as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, fc.width!, fc.height!);
    };

    const onMoving = (e: any) => {
      const obj = e.target as Fabric.Object | undefined;
      if (!obj) return;
      const cw = (fc as any).getWidth() / fc.getZoom();
      const ch = (fc as any).getHeight() / fc.getZoom();
      const b = obj.getBoundingRect();
      const vTargets = [0, cw / 2, cw];
      const hTargets = [0, ch / 2, ch];
      for (const o of fc.getObjects()) {
        if (o === obj) continue;
        const ob = o.getBoundingRect();
        vTargets.push(ob.left, ob.left + ob.width / 2, ob.left + ob.width);
        hTargets.push(ob.top, ob.top + ob.height / 2, ob.top + ob.height);
      }
      const vEdges = [b.left, b.left + b.width / 2, b.left + b.width];
      const hEdges = [b.top, b.top + b.height / 2, b.top + b.height];
      guides = [];
      let dx = 0, dy = 0, foundX = false, foundY = false;
      for (let i = 0; i < vEdges.length && !foundX; i++) {
        for (const t of vTargets) {
          if (Math.abs(vEdges[i] - t) <= SNAP) {
            dx = t - vEdges[i]; guides.push({ o: "v", pos: t }); foundX = true; break;
          }
        }
      }
      for (let i = 0; i < hEdges.length && !foundY; i++) {
        for (const t of hTargets) {
          if (Math.abs(hEdges[i] - t) <= SNAP) {
            dy = t - hEdges[i]; guides.push({ o: "h", pos: t }); foundY = true; break;
          }
        }
      }
      if (dx || dy) {
        obj.set({ left: (obj.left ?? 0) + dx, top: (obj.top ?? 0) + dy });
        obj.setCoords();
      }
      drawGuides();
    };

    fc.on("object:moving", onMoving);
    fc.on("mouse:up", clearGuides);
    fc.on("object:modified", clearGuides);
    return () => {
      fc.off("object:moving", onMoving);
      fc.off("mouse:up", clearGuides);
      fc.off("object:modified", clearGuides);
    };
  }, [fabric, preset]);

  // Keyboard: arrow-move and delete selected objects
  useEffect(() => {
    if (!fabric) return;
    const onKey = (e: KeyboardEvent) => {
      const fc = fcRef.current; if (!fc) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      const obj = fc.getActiveObject();
      if (!obj) return;
      // Don't intercept while editing text
      if ((obj as any).isEditing) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const objs = fc.getActiveObjects();
        objs.forEach((o) => fc.remove(o));
        fc.discardActiveObject();
        fc.requestRenderAll();
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      let moved = false;
      if (e.key === "ArrowLeft") { obj.set({ left: (obj.left ?? 0) - step }); moved = true; }
      else if (e.key === "ArrowRight") { obj.set({ left: (obj.left ?? 0) + step }); moved = true; }
      else if (e.key === "ArrowUp") { obj.set({ top: (obj.top ?? 0) - step }); moved = true; }
      else if (e.key === "ArrowDown") { obj.set({ top: (obj.top ?? 0) + step }); moved = true; }
      if (moved) {
        e.preventDefault();
        obj.setCoords();
        fc.requestRenderAll();
        fc.fire("object:modified", { target: obj } as any);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fabric]);

  // Load Square catalog cache (for binding text layers to item fields)
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("square_items_cache")
        .select("square_item_id, name, description, price_cents, currency")
        .order("name", { ascending: true });
      setSquareItems((data ?? []) as SquareCacheItem[]);
    })();
  }, []);

  // Layer Firebase-sourced Square catalog on top of the Supabase cache.
  // When Firebase items load, they replace the cache entries. Editor stays
  // usable when Firebase is unconfigured or offline (hook returns []).
  const { items: firebaseItems } = useSquareCatalog();
  const { state: squareSyncState } = useSquareSyncState();
  const { trigger: triggerSquareSync, running: squareSyncRunning } = useTriggerSquareSync();
  useEffect(() => {
    if (!firebaseItems || firebaseItems.length === 0) return;
    const mapped: SquareCacheItem[] = firebaseItems.map((it) => {
      const primary = it.variations?.[0];
      return {
        square_item_id: it.squareItemId,
        name: it.name || null,
        description: it.description ?? null,
        price_cents: primary?.priceCents ?? null,
        currency: primary?.currency ?? null,
      };
    });
    setSquareItems(mapped);
  }, [firebaseItems]);

  const refreshBoundTexts = useCallback((items: SquareCacheItem[]) => {
    const fc = fcRef.current;
    if (!fc || !fabric || items.length === 0) return 0;
    const byId = new Map(items.map((i) => [i.square_item_id, i]));
    let touched = 0;
    for (const o of fc.getObjects()) {
      const b = (o as any).squareBinding as SquareBinding | undefined;
      if (!b) continue;
      if (!(o instanceof fabric.IText || o instanceof fabric.Textbox)) continue;
      const next = formatSquareValue(byId.get(b.itemId), b.field);
      if (next && (o as Fabric.IText).text !== next) {
        (o as Fabric.IText).set("text", next);
        touched++;
      }
    }
    if (touched) fc.requestRenderAll();
    return touched;
  }, [fabric]);

  // Sync bound text layers from cache after items load or template loads
  useEffect(() => {
    if (!fabric || !squareItems.length) return;
    refreshBoundTexts(squareItems);
  }, [fabric, squareItems, pendingCanvasJson, refreshBoundTexts]);

  // Hydrate canvas from saved template JSON once canvas exists
  useEffect(() => {
    const fc = fcRef.current;
    if (!fc || !pendingCanvasJson) return;
    historyRef.current.suspend = true;
    (async () => {
      try {
        await fc.loadFromJSON(pendingCanvasJson as object);
        // Rehydrate any video layers (loadFromJSON only restores them as still images)
        if (fabric) {
          const savedObjects = ((pendingCanvasJson as any).objects ?? []) as any[];
          for (const [index, obj] of fc.getObjects().entries()) {
            const savedVideo = savedObjects[index]?.videoStoragePath ? { path: savedObjects[index].videoStoragePath, src: savedObjects[index].videoSrc } : undefined;
            const vp = ((obj as any).videoStoragePath || savedVideo?.path) as string | undefined;
            const src = ((obj as any).videoSrc || savedVideo?.src || (obj as any).getSrc?.()) as string | undefined;
            if (!vp || !src || !(obj instanceof fabric.FabricImage)) continue;
            (obj as any).set("videoStoragePath", vp);
            try {
              const video = document.createElement("video");
              video.src = src;
              video.crossOrigin = "anonymous";
              video.muted = true;
              video.loop = true;
              video.playsInline = true;
              video.autoplay = true;
              await new Promise<void>((resolve, reject) => {
                video.onloadeddata = () => resolve();
                video.onerror = () => reject(new Error("video"));
              });
              video.width = video.videoWidth;
              video.height = video.videoHeight;
              (obj as any).setElement(video);
              (obj as any).objectCaching = false;
              try { await video.play(); } catch { /* blocked */ }
              startVideoRaf(fc, video);
            } catch { /* ignore */ }
          }
        }
        fc.renderAll();
      } finally {
        historyRef.current.suspend = false;
        historyRef.current = { stack: [], index: -1, suspend: false };
        pushHistory();
        setPendingCanvasJson(null);
        refresh();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCanvasJson, fabric, preset]);

  // Convert a gallery image into an editable canvas layer when no template JSON exists
  useEffect(() => {
    const fc = fcRef.current;
    if (!fc || !fabric || !pendingBaseImage) return;
    historyRef.current.suspend = true;
    (async () => {
      try {
        fc.clear();
        fc.backgroundColor = bgColor;
        const img = await fabric.FabricImage.fromURL(pendingBaseImage.url, { crossOrigin: "anonymous" });
        const { w, h } = getCanvasSize(preset);
        const scale = Math.min(w / img.width!, h / img.height!);
        img.scale(scale);
        img.set({
          left: (w - img.width! * scale) / 2,
          top: (h - img.height! * scale) / 2,
          selectable: true,
          imageStoragePath: pendingBaseImage.path,
        });
        fc.add(img);
        fc.setActiveObject(img);
        fc.renderAll();
      } catch {
        toast.error("Could not place image on canvas");
      } finally {
        historyRef.current.suspend = false;
        historyRef.current = { stack: [], index: -1, suspend: false };
        pushHistory();
        setPendingBaseImage(null);
        refresh();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBaseImage, fabric, preset]);

  // Apply zoom
  useEffect(() => {
    const fc = fcRef.current;
    if (!fc) return;
    const { w, h } = getCanvasSize(preset);
    applyCanvasDisplayZoom(fc, w, h, zoom);
  }, [zoom, preset]);

  // Apply bg color
  useEffect(() => {
    const fc = fcRef.current;
    if (!fc) return;
    fc.backgroundColor = bgColor;
    fc.requestRenderAll();
    pushHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgColor]);

  // Load asset library
  useEffect(() => { void loadAssets(); }, []);
  useEffect(() => { void loadCustomFonts(); }, []);

  const registerFont = async (family: string, url: string) => {
    try {
      const face = new FontFace(family, `url(${url})`);
      const loaded = await face.load();
      (document.fonts as any).add(loaded);
      setCustomFonts((prev) => (prev.includes(family) ? prev : [...prev, family]));
    } catch {
      // ignore
    }
  };
  const loadCustomFonts = async () => {
    const { data: ud } = await supabase.auth.getUser();
    if (!ud.user) return;
    const { data } = await supabase.storage.from("fonts").list(ud.user.id, { limit: 100 });
    if (!data) return;
    for (const f of data) {
      const path = `${ud.user.id}/${f.name}`;
      const { data: signed } = await supabase.storage.from("fonts").createSignedUrl(path, 3600);
      if (!signed?.signedUrl) continue;
      const family = f.name.replace(/\.(otf|ttf|woff2?|woff)$/i, "");
      await registerFont(family, signed.signedUrl);
    }
  };
  const onUploadFont = async (file: File) => {
    const ok = /\.(otf|ttf|woff2?|woff)$/i.test(file.name);
    if (!ok) { toast.error("Use .otf, .ttf, .woff or .woff2"); return; }
    setUploadingFont(true);
    try {
      const { data: ud } = await supabase.auth.getUser();
      if (!ud.user) { toast.error("Sign in required"); return; }
      const safe = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${ud.user.id}/${safe}`;
      const { error } = await supabase.storage.from("fonts").upload(path, file, { upsert: true, contentType: file.type || "font/otf" });
      if (error) throw error;
      const { data: signed } = await supabase.storage.from("fonts").createSignedUrl(path, 3600);
      if (!signed?.signedUrl) throw new Error("No URL");
      const family = safe.replace(/\.(otf|ttf|woff2?|woff)$/i, "");
      await registerFont(family, signed.signedUrl);
      toast.success(`Font "${family}" added`);
    } catch (e: any) {
      toast.error(e?.message ?? "Font upload failed");
    } finally {
      setUploadingFont(false);
    }
  };

  const loadAssets = async () => {
    const { data: ud } = await supabase.auth.getUser();
    if (!ud.user) return;
    const { data } = await supabase.from("images").select("id, title, variants").eq("user_id", ud.user.id).order("created_at", { ascending: false }).limit(50);
    if (!data) return;
    const out: Asset[] = [];
    for (const row of data) {
      const variants = (row.variants as Array<{ path: string; format: string }>) || [];
      const v = variants[0];
      if (!v) continue;
      const { data: signed } = await supabase.storage.from("images").createSignedUrl(v.path, 3600);
      if (signed?.signedUrl) out.push({ id: row.id, title: row.title, url: signed.signedUrl, path: v.path });
    }
    setAssets(out);
  };

  // History
  const pushHistory = () => {
    const fc = fcRef.current;
    if (!fc || historyRef.current.suspend) return;
    const canvasJson = (fc as any).toObject(["imageStoragePath", "squareBinding", "videoStoragePath", "videoSrc"]);
    patchSerializedMedia(canvasJson.objects, fc.getObjects());
    const json = JSON.stringify(canvasJson);
    const h = historyRef.current;
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(json);
    if (h.stack.length > 50) h.stack.shift();
    h.index = h.stack.length - 1;
  };
  const undo = async () => {
    const h = historyRef.current; const fc = fcRef.current;
    if (!fc || h.index <= 0) return;
    h.index -= 1; h.suspend = true;
    await fc.loadFromJSON(h.stack[h.index]); fc.renderAll();
    h.suspend = false; refresh();
  };
  const redo = async () => {
    const h = historyRef.current; const fc = fcRef.current;
    if (!fc || h.index >= h.stack.length - 1) return;
    h.index += 1; h.suspend = true;
    await fc.loadFromJSON(h.stack[h.index]); fc.renderAll();
    h.suspend = false; refresh();
  };

  // Add helpers
  const addImageFromUrl = async (url: string, path?: string) => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
    const { w, h } = getCanvasSize(preset);
    const max = Math.min(w * 0.6, h * 0.6);
    const scale = Math.min(max / img.width!, max / img.height!, 1);
    img.scale(scale);
    img.set({ left: (w - img.width! * scale) / 2, top: (h - img.height! * scale) / 2 });
    if (path) img.set("imageStoragePath", path);
    fc.add(img); fc.setActiveObject(img); fc.renderAll();
  };
  const onUploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const tId = toast.loading("Uploading image…");
    try {
      const res = await uploadEditedMediaToFirebase({
        kind: "image",
        blob: file,
        contentType: file.type || "image/png",
        name: file.name,
      });
      toast.loading("Processing image…", { id: tId });
      const ready = await waitForMediaReady(res.mediaDocId).catch(() => null);
      const finalUrl = (ready?.url as string) || res.url;
      const finalPath = (ready?.path as string) || res.path;
      toast.dismiss(tId);
      await addImageFromUrl(finalUrl, finalPath);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Image upload failed", { id: tId });
    } finally {
      e.target.value = "";
    }
  };

  const videoRafRef = useRef<Set<number>>(new Set());
  const startVideoRaf = (fc: Fabric.Canvas, video: HTMLVideoElement) => {
    let rafId = 0;
    const tick = () => {
      if (video.paused || video.ended) {
        videoRafRef.current.delete(rafId);
        return;
      }
      fc.requestRenderAll();
      rafId = requestAnimationFrame(tick);
      videoRafRef.current.add(rafId);
    };
    rafId = requestAnimationFrame(tick);
    videoRafRef.current.add(rafId);
  };
  const addVideoFromUrl = async (url: string, path?: string) => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    video.preload = "auto";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onErr = () => {
        cleanup();
        const code = video.error?.code;
        reject(new Error(`Could not load video (code ${code ?? "?"}). Format may be unsupported by the browser.`));
      };
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("error", onErr);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("error", onErr, { once: true });
      try { video.load(); } catch { /* ignore */ }
    });
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    video.width = vw;
    video.height = vh;
    const img = new fabric.FabricImage(video, { objectCaching: false, width: vw, height: vh });
    const { w, h } = getCanvasSize(preset);
    const max = Math.min(w * 0.6, h * 0.6);
    const scale = Math.min(max / vw, max / vh, 1);
    img.scale(scale);
    img.set({
      left: (w - vw * scale) / 2,
      top: (h - vh * scale) / 2,
    });
    if (path) img.set("videoStoragePath", path);
    fc.add(img); fc.setActiveObject(img); fc.requestRenderAll();
    try { await video.play(); } catch { /* autoplay may be blocked until interaction */ }
    startVideoRaf(fc, video);
    pushHistory(); refresh();
    toast.success("Video added to canvas");
  };
  const onUploadVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.error("Video too large (max 50MB)");
      e.target.value = "";
      return;
    }
    setPendingVideoFile(file);
    e.target.value = "";
  };
  const handleEditedVideoSave = async (result: EditedVideoResult) => {
    const tId = toast.loading("Uploading edited video to Firebase…");
    try {
      const res = await uploadEditedMediaToFirebase({
        kind: "video",
        blob: result.videoBlob,
        contentType: result.videoMime || "video/mp4",
        thumbnailBlob: result.thumbnailBlob,
        thumbnailContentType: "image/jpeg",
        width: result.width ?? null,
        height: result.height ?? null,
        durationSeconds: result.durationSeconds ?? null,
        name: pendingVideoFile?.name,
      });
      toast.loading("Cloud Function is transcoding video…", { id: tId });
      const ready = await waitForMediaReady(res.mediaDocId).catch((err) => {
        console.warn("[video upload] waitForMediaReady failed:", err);
        return null;
      });
      const finalUrl = (ready?.url as string) || res.url;
      const finalPath = (ready?.path as string) || res.path;
      toast.success("Video ready", { id: tId });
      try {
        await addVideoFromUrl(finalUrl, finalPath);
      } catch (err) {
        console.error("[video upload] failed to place on canvas:", err);
        toast.error(err instanceof Error ? err.message : "Could not place video");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Video upload failed", { id: tId });
    } finally {
      setPendingVideoFile(null);
    }
  };
  const addText = () => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const { w, h } = getCanvasSize(preset);
    const t = new fabric.IText("Your text", {
      left: w / 2 - 200, top: h / 2 - 40, fontSize: 80, fill: "#111827",
      fontFamily: "Inter", originX: "left", originY: "top",
    });
    fc.add(t); fc.setActiveObject(t); fc.renderAll();
  };
  const addShape = (kind: "rect" | "circle" | "triangle") => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const { w, h } = getCanvasSize(preset);
    const common = { left: w / 2 - 150, top: h / 2 - 150, fill: "#3b82f6" };
    let o: Fabric.Object;
    if (kind === "rect") o = new fabric.Rect({ ...common, width: 300, height: 200 });
    else if (kind === "circle") o = new fabric.Circle({ ...common, radius: 120 });
    else o = new fabric.Triangle({ ...common, width: 240, height: 240 });
    fc.add(o); fc.setActiveObject(o); fc.renderAll();
  };

  // Active-object actions
  const a = active;
  const update = (fn: () => void) => { fn(); fcRef.current?.renderAll(); pushHistory(); refresh(); };
  const remove = () => { const fc = fcRef.current; const o = fc?.getActiveObject(); if (fc && o) { fc.remove(o); fc.discardActiveObject(); fc.renderAll(); }};
  const duplicate = async () => {
    const fc = fcRef.current; const o = fc?.getActiveObject(); if (!fc || !o) return;
    const c = await o.clone(); c.set({ left: (o.left ?? 0) + 30, top: (o.top ?? 0) + 30 }); fc.add(c); fc.setActiveObject(c); fc.renderAll();
  };
  const bringForward = () => { const fc = fcRef.current; const o = fc?.getActiveObject(); if (fc && o) { fc.bringObjectForward(o); fc.renderAll(); pushHistory(); refresh(); }};
  const sendBackward = () => { const fc = fcRef.current; const o = fc?.getActiveObject(); if (fc && o) { fc.sendObjectBackwards(o); fc.renderAll(); pushHistory(); refresh(); }};
  const rotate = () => { if (a) update(() => a.rotate(((a.angle || 0) + 90) % 360)); };
  const flipH = () => { if (a) update(() => a.set("flipX", !a.flipX)); };
  const flipV = () => { if (a) update(() => a.set("flipY", !a.flipY)); };

  const fitImageToCanvas = () => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const current = fc.getActiveObject();
    const target = (current instanceof fabric.FabricImage)
      ? current
      : (fc.getObjects().find((o) => o instanceof fabric.FabricImage) as Fabric.FabricImage | undefined);
    if (!target) { toast.error("No image on the canvas to fit"); return; }
    update(() => {
      target.set({
        angle: 0,
        flipX: false,
        flipY: false,
        skewX: 0,
        skewY: 0,
        cropX: 0,
        cropY: 0,
        originX: "left",
        originY: "top",
        scaleX: 1,
        scaleY: 1,
        strokeWidth: 0,
        padding: 0,
      });
      const { w: cw, h: ch } = getCanvasSize(preset);
      const originalSize = (target as any).getOriginalSize?.() as { width?: number; height?: number } | undefined;
      const el = (target as any).getElement?.() as HTMLImageElement | HTMLVideoElement | undefined;
      const iw = originalSize?.width || (el && ("naturalWidth" in el ? el.naturalWidth : (el as HTMLVideoElement).videoWidth)) || target.width!;
      const ih = originalSize?.height || (el && ("naturalHeight" in el ? el.naturalHeight : (el as HTMLVideoElement).videoHeight)) || target.height!;
      target.set({ width: iw, height: ih, cropX: 0, cropY: 0 });
      const scale = Math.max(cw / iw, ch / ih);
      target.set({ scaleX: scale, scaleY: scale });
      target.set({
        left: (cw - iw * scale) / 2,
        top: (ch - ih * scale) / 2,
      });
      target.setCoords();
      fc.setActiveObject(target);
    });
  };

  if (!fabric) {
    return <div className="flex h-screen items-center justify-center bg-muted/30 text-muted-foreground">Loading editor…</div>;
  }

  const isText = !!fabric && (a instanceof fabric.IText || a instanceof fabric.Textbox);
  const isImage = !!fabric && a instanceof fabric.FabricImage;
  const objects = fcRef.current?.getObjects() ?? [];

  const onSave = async () => {
    const fc = fcRef.current; if (!fc) return;
    setSaving(true);
    try {
      fc.discardActiveObject();
      const { w, h } = getCanvasSize(preset);
      const prevZoom = zoom;
      applyCanvasDisplayZoom(fc, w, h, 1);
      fc.setDimensions({ width: w, height: h });
      fc.renderAll();
      const dataUrl = fc.toDataURL({ format: "png", multiplier: 1 });
      const canvasJson = (fc as any).toObject(["imageStoragePath", "squareBinding", "videoStoragePath", "videoSrc"]);
      patchSerializedMedia(canvasJson.objects, fc.getObjects());
      applyCanvasDisplayZoom(fc, w, h, prevZoom);

      const blob = await (await fetch(dataUrl)).blob();
      const { best, variants, originalSize, width: imageWidth, height: imageHeight } = await autoCompress(blob);
      const { data: ud } = await supabase.auth.getUser();
      const userId = ud.user!.id;

      // Persist editable template (insert or update)
      let savedTemplateId = templateId;
      const tplPayload = {
        user_id: userId,
        name: title,
        preset,
        width: w,
        height: h,
        canvas_json: JSON.parse(JSON.stringify(canvasJson)),
      };
      if (savedTemplateId) {
        const { error: upErr } = await supabase
          .from("templates")
          .update({ ...tplPayload, updated_at: new Date().toISOString() })
          .eq("id", savedTemplateId);
        if (upErr) throw upErr;
      } else {
        const { data: tplRow, error: tplErr } = await supabase
          .from("templates")
          .insert(tplPayload)
          .select("id")
          .single();
        if (tplErr) throw tplErr;
        savedTemplateId = tplRow.id;
        setTemplateId(savedTemplateId);
      }

      const { data: existingImage } = imageIdParam
        ? await supabase.from("images").select("id, slug").eq("user_id", userId).eq("id", imageIdParam).maybeSingle()
        : savedTemplateId
          ? await supabase
              .from("images")
              .select("id, slug")
              .eq("user_id", userId)
              .eq("template_id", savedTemplateId)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle()
          : { data: null };
      const slug = existingImage?.slug ?? nanoid(10);
      const baseFolder = `${userId}/${slug}`;
      const variantRecords: { format: string; path: string; size: number; quality: number }[] = [];
      for (const v of variants) {
        const path = `${baseFolder}/image.${v.format === "jpeg" ? "jpg" : v.format}`;
        const { error } = await supabase.storage.from("images").upload(path, v.blob, { contentType: v.blob.type, upsert: true });
        if (error) throw error;
        variantRecords.push({ format: v.format, path, size: v.size, quality: v.quality });
      }
      variantRecords.sort((x, y) => x.size - y.size);

      const imagePayload = {
        user_id: userId, slug, title, width: imageWidth, height: imageHeight,
        original_size_bytes: originalSize, optimized_size_bytes: best.size,
        variants: variantRecords, preset, source: "editor",
        template_id: savedTemplateId,
      };
      const { error: insErr } = existingImage
        ? await supabase.from("images").update(imagePayload).eq("id", existingImage.id)
        : await supabase.from("images").insert(imagePayload);
      if (insErr) throw insErr;
      toast.success(`Saved! Compressed ${Math.round((1 - best.size / originalSize) * 100)}%`);
      
    } catch (e: any) {
      toast.error(e.message || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="flex h-screen bg-muted/30">
      <VideoEditorDialog
        file={pendingVideoFile}
        open={!!pendingVideoFile}
        onCancel={() => setPendingVideoFile(null)}
        onSave={handleEditedVideoSave}
      />
      {/* LEFT PANEL */}
      <div className="w-72 border-r border-border bg-card flex flex-col">
        <div className="p-3 border-b border-border">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" className="font-medium" />
        </div>
        <Tabs defaultValue="add" className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid grid-cols-3 m-2">
            <TabsTrigger value="add"><Plus className="size-4" /></TabsTrigger>
            <TabsTrigger value="uploads"><ImageIcon className="size-4" /></TabsTrigger>
            <TabsTrigger value="layers"><Layers className="size-4" /></TabsTrigger>
          </TabsList>

          <TabsContent value="add" className="flex-1 overflow-auto px-3 pb-3 space-y-4 mt-0">
            <div>
              <Label className="text-xs">Canvas size</Label>
              <Select value={preset} onValueChange={setPreset}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(PRESETS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Background</Label>
              <div className="flex gap-2 mt-1">
                <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="h-9 w-12 rounded border border-border bg-transparent cursor-pointer" />
                <Input value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="flex-1" />
              </div>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label className="text-xs">Add elements</Label>
              <Button variant="outline" className="w-full justify-start" onClick={addText}><Type className="size-4 mr-2" /> Text</Button>
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" onClick={() => addShape("rect")}><SquareIcon className="size-4" /></Button>
                <Button variant="outline" onClick={() => addShape("circle")}><CircleIcon className="size-4" /></Button>
                <Button variant="outline" onClick={() => addShape("triangle")}><TriangleIcon className="size-4" /></Button>
              </div>
              <label className="flex items-center justify-center gap-2 px-3 py-2 border border-dashed border-border rounded-md text-sm cursor-pointer hover:bg-accent">
                <Upload className="size-4" /> Upload image
                <input type="file" accept="image/*" className="hidden" onChange={onUploadImage} />
              </label>
              <label className="flex items-center justify-center gap-2 px-3 py-2 border border-dashed border-border rounded-md text-sm cursor-pointer hover:bg-accent">
                <VideoIcon className="size-4" /> Upload video
                <input type="file" accept="video/*" className="hidden" onChange={onUploadVideo} />
              </label>
            </div>
          </TabsContent>

          <TabsContent value="uploads" className="flex-1 overflow-hidden mt-0 px-3 pb-3 flex flex-col">
            <label className="flex items-center justify-center gap-2 px-3 py-2 border border-dashed border-border rounded-md text-sm cursor-pointer hover:bg-accent mb-3">
              <Upload className="size-4" /> Upload new
              <input type="file" accept="image/*" className="hidden" onChange={async (e) => { await onUploadImage(e); void loadAssets(); }} />
            </label>
            <ScrollArea className="flex-1 -mx-1">
              <div className="grid grid-cols-2 gap-2 px-1">
                {assets.length === 0 && <p className="col-span-2 text-xs text-muted-foreground text-center py-6">No saved images yet</p>}
                {assets.map((asset) => (
                  <button key={asset.id} onClick={() => addImageFromUrl(asset.url, asset.path)} className="group relative aspect-square rounded overflow-hidden border border-border hover:border-primary">
                    <img src={asset.url} alt={asset.title} className="size-full object-cover" />
                  </button>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="layers" className="flex-1 overflow-auto mt-0 px-3 pb-3">
            <div className="space-y-1">
              {[...objects].reverse().map((obj, idx) => {
                const realIdx = objects.length - 1 - idx;
                const label = obj instanceof fabric.IText || obj instanceof fabric.Textbox
                  ? `T  ${(obj.text || "").slice(0, 20) || "Text"}`
                  : obj instanceof fabric.FabricImage ? "🖼  Image"
                  : obj instanceof fabric.Circle ? "○  Circle"
                  : obj instanceof fabric.Triangle ? "△  Triangle" : "▭  Shape";
                const isActive = a === obj;
                return (
                  <div key={realIdx} className={`flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer ${isActive ? "bg-accent" : "hover:bg-accent/50"}`}
                    onClick={() => { fcRef.current?.setActiveObject(obj); fcRef.current?.renderAll(); refresh(); }}>
                    <button onClick={(e) => { e.stopPropagation(); obj.visible = !obj.visible; fcRef.current?.renderAll(); refresh(); }} className="text-muted-foreground hover:text-foreground">
                      {obj.visible !== false ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </button>
                    <span className="flex-1 truncate">{label}</span>
                  </div>
                );
              })}
              {objects.length === 0 && <p className="text-xs text-muted-foreground text-center py-6">No layers yet</p>}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* CENTER */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card">
          <Button variant="ghost" size="sm" onClick={undo}><Undo2 className="size-4" /></Button>
          <Button variant="ghost" size="sm" onClick={redo}><Redo2 className="size-4" /></Button>
          <Separator orientation="vertical" className="h-6 mx-1" />
          <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.max(0.1, z - 0.1))}><ZoomOut className="size-4" /></Button>
          <span className="text-xs w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="sm" onClick={() => setZoom((z) => Math.min(2, z + 0.1))}><ZoomIn className="size-4" /></Button>
          <Button variant="ghost" size="sm" onClick={() => setZoom(getFitZoom())}><Maximize2 className="size-4" /></Button>
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const { data } = await supabase
                .from("square_items_cache")
                .select("square_item_id, name, description, price_cents, currency")
                .order("name", { ascending: true });
              const items = (data ?? []) as SquareCacheItem[];
              setSquareItems(items);
              const n = refreshBoundTexts(items);
              toast.success(n ? `Updated ${n} bound layer${n === 1 ? "" : "s"}` : "All bound layers up to date");
            }}
            title="Refresh bound text layers from Square cache"
          >
            <RefreshCw className="size-4 mr-1.5" /> Refresh prices
          </Button>
          {squareSyncState && (
            <span
              className={
                "text-[10px] px-1.5 py-0.5 rounded border " +
                (squareSyncState.lastStatus === "error"
                  ? "border-destructive text-destructive"
                  : squareSyncState.lastStatus === "running"
                  ? "border-muted-foreground text-muted-foreground"
                  : "border-border text-muted-foreground")
              }
              title={squareSyncState.lastError ?? undefined}
            >
              Square: {squareSyncState.lastStatus ?? "idle"}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={squareSyncRunning}
            onClick={async () => {
              try {
                const res = await triggerSquareSync();
                toast.success(`Square sync complete (${res.itemCount} items)`);
                if (firebaseItems.length) refreshBoundTexts(squareItems);
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Square sync failed");
              }
            }}
            title="Pull the latest catalog from Square via Firebase"
          >
            <RefreshCw className={"size-4 mr-1.5 " + (squareSyncRunning ? "animate-spin" : "")} />
            {squareSyncRunning ? "Syncing…" : "Sync Square"}
          </Button>
          <Button onClick={onSave} disabled={saving}>
            <Save className="size-4 mr-1.5" /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>
        <div ref={canvasHostRef} className="flex-1 overflow-auto flex items-start justify-center p-8">
          <div className="bg-white shadow-[var(--shadow-elegant)] inline-block">
            <canvas ref={canvasRef} />
          </div>
        </div>
      </div>

      {/* RIGHT PANEL — properties */}
      <div className="w-72 border-l border-border bg-card overflow-y-auto">
        {!a && <div className="p-6 text-sm text-muted-foreground text-center">Select an element to edit its properties</div>}
        {a && (
          <div className="p-3 space-y-4">
            <div className="grid grid-cols-4 gap-1">
              <Button variant="outline" size="sm" onClick={duplicate} title="Duplicate"><Copy className="size-4" /></Button>
              <Button variant="outline" size="sm" onClick={bringForward} title="Bring forward"><ArrowUp className="size-4" /></Button>
              <Button variant="outline" size="sm" onClick={sendBackward} title="Send backward"><ArrowDown className="size-4" /></Button>
              <Button variant="outline" size="sm" onClick={remove} title="Delete"><Trash2 className="size-4" /></Button>
            </div>
            <div className="grid grid-cols-3 gap-1">
              <Button variant="outline" size="sm" onClick={rotate}><RotateCw className="size-4" /></Button>
              <Button variant="outline" size="sm" onClick={flipH}><FlipHorizontal className="size-4" /></Button>
              <Button variant="outline" size="sm" onClick={flipV}><FlipVertical className="size-4" /></Button>
            </div>
            {isImage && (
              <Button variant="outline" size="sm" className="w-full" onClick={fitImageToCanvas}>
                <Maximize2 className="size-4 mr-2" /> Fit image to canvas
              </Button>
            )}
            <Separator />

            {isText && (
              <>
                <div>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Font</Label>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={uploadingFont}
                      onClick={() => fontInputRef.current?.click()}
                    >
                      <Upload className="size-3 mr-1" />
                      {uploadingFont ? "Uploading…" : "Upload"}
                    </Button>
                  </div>
                  <input
                    ref={fontInputRef}
                    type="file"
                    accept=".otf,.ttf,.woff,.woff2,font/otf,font/ttf,font/woff,font/woff2"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onUploadFont(f);
                      e.target.value = "";
                    }}
                  />
                  <Select value={(a as Fabric.IText).fontFamily as string} onValueChange={(v) => update(() => { (a as Fabric.IText).set("fontFamily", v); fcRef.current?.requestRenderAll(); })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[...FONTS, ...customFonts].map((f) => <SelectItem key={f} value={f} style={{ fontFamily: f }}>{f}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Size ({(a as Fabric.IText).fontSize})</Label>
                  <Slider min={8} max={400} step={1} value={[(a as Fabric.IText).fontSize as number]} onValueChange={(v) => update(() => (a as Fabric.IText).set("fontSize", v[0]))} className="mt-2" />
                </div>
                <div className="flex gap-1">
                  <Button variant={(a as Fabric.IText).fontWeight === "bold" ? "default" : "outline"} size="sm" onClick={() => update(() => (a as Fabric.IText).set("fontWeight", (a as Fabric.IText).fontWeight === "bold" ? "normal" : "bold"))}><Bold className="size-4" /></Button>
                  <Button variant={(a as Fabric.IText).fontStyle === "italic" ? "default" : "outline"} size="sm" onClick={() => update(() => (a as Fabric.IText).set("fontStyle", (a as Fabric.IText).fontStyle === "italic" ? "normal" : "italic"))}><Italic className="size-4" /></Button>
                  <Button variant={(a as Fabric.IText).underline ? "default" : "outline"} size="sm" onClick={() => update(() => (a as Fabric.IText).set("underline", !(a as Fabric.IText).underline))}><Underline className="size-4" /></Button>
                </div>
                <ToggleGroup type="single" value={(a as Fabric.IText).textAlign as string} onValueChange={(v) => v && update(() => (a as Fabric.IText).set("textAlign", v))} className="justify-start">
                  <ToggleGroupItem value="left"><AlignLeft className="size-4" /></ToggleGroupItem>
                  <ToggleGroupItem value="center"><AlignCenter className="size-4" /></ToggleGroupItem>
                  <ToggleGroupItem value="right"><AlignRight className="size-4" /></ToggleGroupItem>
                </ToggleGroup>
                <Separator />
                <div className="space-y-2">
                  <Label className="text-xs flex items-center gap-1.5"><Tag className="size-3" /> Square binding</Label>
                  {squareItems.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No cached items. Sync your Square catalog from the Templates page first.</p>
                  ) : (
                    <>
                      <Select
                        value={((a as any).squareBinding as SquareBinding | undefined)?.itemId ?? "__none__"}
                        onValueChange={(v) => update(() => {
                          if (v === "__none__") {
                            delete (a as any).squareBinding;
                            return;
                          }
                          const prev = ((a as any).squareBinding as SquareBinding | undefined);
                          const field: SquareField = prev?.field ?? "price";
                          (a as any).squareBinding = { itemId: v, field } as SquareBinding;
                          const item = squareItems.find((s) => s.square_item_id === v);
                          const next = formatSquareValue(item, field);
                          if (next) (a as Fabric.IText).set("text", next);
                        })}
                      >
                        <SelectTrigger><SelectValue placeholder="Bind to item…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— Not bound —</SelectItem>
                          {squareItems.map((it) => (
                            <SelectItem key={it.square_item_id} value={it.square_item_id}>
                              {it.name ?? it.square_item_id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {((a as any).squareBinding as SquareBinding | undefined) && (
                        <Select
                          value={((a as any).squareBinding as SquareBinding).field}
                          onValueChange={(v) => update(() => {
                            const b = (a as any).squareBinding as SquareBinding;
                            b.field = v as SquareField;
                            const item = squareItems.find((s) => s.square_item_id === b.itemId);
                            const next = formatSquareValue(item, b.field);
                            if (next) (a as Fabric.IText).set("text", next);
                          })}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="price">Price</SelectItem>
                            <SelectItem value="name">Name</SelectItem>
                            <SelectItem value="description">Description</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        Text auto-updates when you sync Square or click Refresh prices.
                      </p>
                    </>
                  )}
                </div>
              </>
            )}

            {(isText || (!isImage && a)) && (
              <ColorField label={isText ? "Text color" : "Fill"} value={(a.fill as string) ?? "#000000"} onChange={(c) => update(() => a.set("fill", c))} />
            )}

            {!isImage && a && (
              <>
                <ColorField label="Stroke" value={(a.stroke as string) ?? "#000000"} onChange={(c) => update(() => a.set("stroke", c))} />
                <div>
                  <Label className="text-xs">Stroke width ({a.strokeWidth ?? 0})</Label>
                  <Slider min={0} max={40} step={1} value={[a.strokeWidth ?? 0]} onValueChange={(v) => update(() => a.set("strokeWidth", v[0]))} className="mt-2" />
                </div>
              </>
            )}

            {isImage && (
              <ImageFilters fabric={fabric} image={a as Fabric.FabricImage} onChange={() => { fcRef.current?.renderAll(); pushHistory(); refresh(); }} />
            )}

            <div>
              <Label className="text-xs">Opacity ({Math.round((a.opacity ?? 1) * 100)}%)</Label>
              <Slider min={0} max={100} step={1} value={[(a.opacity ?? 1) * 100]} onValueChange={(v) => update(() => a.set("opacity", v[0] / 100))} className="mt-2" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="flex gap-2 mt-1">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-12 rounded border border-border bg-transparent cursor-pointer" />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="flex-1" />
      </div>
      <div className="flex flex-wrap gap-1 mt-2">
        {SWATCHES.map((c) => (
          <button key={c} onClick={() => onChange(c)} className="size-5 rounded border border-border" style={{ background: c }} />
        ))}
      </div>
    </div>
  );
}

function ImageFilters({ fabric, image, onChange }: { fabric: FabricModule; image: Fabric.FabricImage; onChange: () => void }) {
  const getFilter = (Type: any) => image.filters.find((f: unknown) => f instanceof Type) as any;
  const setFilter = (Type: any, opts: Record<string, number>) => {
    image.filters = image.filters.filter((f: unknown) => !(f instanceof Type));
    image.filters.push(new Type(opts));
    image.applyFilters();
    onChange();
  };
  const brightness = (getFilter(fabric.filters.Brightness) as any)?.brightness ?? 0;
  const contrast = (getFilter(fabric.filters.Contrast) as any)?.contrast ?? 0;
  const saturation = (getFilter(fabric.filters.Saturation) as any)?.saturation ?? 0;
  const blur = (getFilter(fabric.filters.Blur) as any)?.blur ?? 0;
  return (
    <>
      <div>
        <Label className="text-xs">Brightness ({Math.round(brightness * 100)})</Label>
        <Slider min={-100} max={100} step={1} value={[brightness * 100]} onValueChange={(v) => setFilter(fabric.filters.Brightness, { brightness: v[0] / 100 })} className="mt-2" />
      </div>
      <div>
        <Label className="text-xs">Contrast ({Math.round(contrast * 100)})</Label>
        <Slider min={-100} max={100} step={1} value={[contrast * 100]} onValueChange={(v) => setFilter(fabric.filters.Contrast, { contrast: v[0] / 100 })} className="mt-2" />
      </div>
      <div>
        <Label className="text-xs">Saturation ({Math.round(saturation * 100)})</Label>
        <Slider min={-100} max={100} step={1} value={[saturation * 100]} onValueChange={(v) => setFilter(fabric.filters.Saturation, { saturation: v[0] / 100 })} className="mt-2" />
      </div>
      <div>
        <Label className="text-xs">Blur ({Math.round(blur * 100)})</Label>
        <Slider min={0} max={100} step={1} value={[blur * 100]} onValueChange={(v) => setFilter(fabric.filters.Blur, { blur: v[0] / 100 })} className="mt-2" />
      </div>
    </>
  );
}
