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
import { uploadCompanyMedia, redirectToReturnUrl } from "@/integrations/firebase/company-media";
import { getSignageSettings } from "@/lib/signage.functions";
import {
  Upload, Type, Square as SquareIcon, Circle as CircleIcon, Triangle as TriangleIcon,
  RotateCw, FlipHorizontal, FlipVertical, Save, Trash2, Copy,
  ArrowUp, ArrowDown, Undo2, Redo2, ZoomIn, ZoomOut, Maximize2,
  Image as ImageIcon, Layers, Eye, EyeOff, Bold, Italic, Underline,
  AlignLeft, AlignCenter, AlignRight, Plus, Tag, RefreshCw, Video as VideoIcon,
  Pencil, Eraser, Minus, MoveUpRight, Star, Hexagon, Ruler, MousePointer2,
  Play, Sparkles,
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

// Persisted animation presets. Stored on each fabric object as `animation`
// so the renderer (or a future preview) can replay them.
type AnimationType =
  | "none"
  | "fade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "zoom-in"
  | "zoom-out"
  | "spin"
  | "pulse"
  | "bounce"
  | "slideshow";
type ObjectAnimation = {
  type: AnimationType;
  duration: number;
  delay: number;
  loop: boolean;
  /** Slideshow: seconds each frame is shown. */
  interval?: number;
};
const ANIMATION_OPTIONS: { value: AnimationType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade in" },
  { value: "slide-left", label: "Slide from left" },
  { value: "slide-right", label: "Slide from right" },
  { value: "slide-up", label: "Slide from top" },
  { value: "slide-down", label: "Slide from bottom" },
  { value: "zoom-in", label: "Zoom in" },
  { value: "zoom-out", label: "Zoom out" },
  { value: "spin", label: "Spin" },
  { value: "pulse", label: "Pulse" },
  { value: "bounce", label: "Bounce in" },
  { value: "slideshow", label: "Slideshow (images)" },
];

/** Slideshow frame stored on a FabricImage as `slideshowImages`. */
type SlideshowFrame = { url: string; path?: string };

/** Stop any currently-running slideshow on this object. */
function stopSlideshow(obj: any) {
  if (obj?.__slideshowTimer) {
    clearTimeout(obj.__slideshowTimer);
    obj.__slideshowTimer = null;
  }
  obj.__slideshowRunning = false;
}

function playSlideshow(fc: Fabric.Canvas, obj: any, fabric: FabricModule, anim: ObjectAnimation) {
  const frames: SlideshowFrame[] = Array.isArray(obj.slideshowImages) ? obj.slideshowImages : [];
  const baseSrc = getFabricObjectSrc(obj);
  const allUrls: string[] = [baseSrc, ...frames.map((f) => f.url)].filter(Boolean) as string[];
  if (allUrls.length < 2) return;
  const interval = Math.max(300, (anim.interval ?? 2) * 1000);
  const fadeMs = Math.min(400, Math.floor(interval / 3));
  const baseOpacity = obj.opacity ?? 1;
  stopSlideshow(obj);
  obj.__slideshowRunning = true;

  let idx = 0;
  const tween = (start: number, end: number, duration: number, onDone?: () => void) => {
    (fabric as any).util.animate({
      startValue: start, endValue: end, duration,
      onChange: (v: number) => { obj.set("opacity", v); fc.requestRenderAll(); },
      onComplete: () => { obj.set("opacity", end); onDone?.(); },
    });
  };

  const goNext = async () => {
    if (!obj.__slideshowRunning) return;
    const next = (idx + 1) % allUrls.length;
    // Stop after one cycle if not looping.
    if (!anim.loop && next === 0) { stopSlideshow(obj); return; }
    tween(baseOpacity, 0, fadeMs, async () => {
      try {
        await (obj as any).setSrc(allUrls[next], { crossOrigin: "anonymous" });
      } catch { /* ignore broken frame */ }
      idx = next;
      fc.requestRenderAll();
      tween(0, baseOpacity, fadeMs, () => {
        if (!obj.__slideshowRunning) return;
        obj.__slideshowTimer = setTimeout(goNext, Math.max(50, interval - 2 * fadeMs));
      });
    });
  };

  // Start cycle after the first display interval.
  obj.__slideshowTimer = setTimeout(goNext, interval);
}

function playObjectAnimation(
  fc: Fabric.Canvas,
  obj: any,
  fabric: FabricModule,
) {
  const anim = obj.animation as ObjectAnimation | undefined;
  if (!anim || anim.type === "none") return;
  const dur = Math.max(50, (anim.duration ?? 1) * 1000);
  const delay = Math.max(0, (anim.delay ?? 0) * 1000);
  const orig = {
    left: obj.left ?? 0,
    top: obj.top ?? 0,
    opacity: obj.opacity ?? 1,
    scaleX: obj.scaleX ?? 1,
    scaleY: obj.scaleY ?? 1,
    angle: obj.angle ?? 0,
  };
  const cw = (fc as any).getWidth() / fc.getZoom();
  const ch = (fc as any).getHeight() / fc.getZoom();
  const ease = (fabric as any).util?.ease ?? {};
  const render = () => fc.requestRenderAll();

  const runOnce = (after?: () => void) => {
    const tween = (opts: any) => (fabric as any).util.animate({ ...opts, onComplete: () => { opts.onComplete?.(); after?.(); } });
    switch (anim.type) {
      case "fade":
        obj.set({ opacity: 0 });
        tween({
          startValue: 0, endValue: orig.opacity, duration: dur,
          onChange: (v: number) => { obj.set("opacity", v); render(); },
          onComplete: () => obj.set("opacity", orig.opacity),
        });
        break;
      case "slide-left":
      case "slide-right":
      case "slide-up":
      case "slide-down": {
        const key: "left" | "top" = anim.type === "slide-up" || anim.type === "slide-down" ? "top" : "left";
        const from = anim.type === "slide-left" ? orig.left - cw
          : anim.type === "slide-right" ? orig.left + cw
          : anim.type === "slide-up" ? orig.top - ch
          : orig.top + ch;
        const target = key === "left" ? orig.left : orig.top;
        obj.set(key, from); obj.setCoords();
        tween({
          startValue: from, endValue: target, duration: dur, easing: ease.easeOutCubic,
          onChange: (v: number) => { obj.set(key, v); obj.setCoords(); render(); },
          onComplete: () => { obj.set({ left: orig.left, top: orig.top }); obj.setCoords(); },
        });
        break;
      }
      case "zoom-in":
        obj.set({ scaleX: orig.scaleX * 0.01, scaleY: orig.scaleY * 0.01 });
        tween({
          startValue: 0.01, endValue: 1, duration: dur, easing: ease.easeOutCubic,
          onChange: (v: number) => { obj.set({ scaleX: orig.scaleX * v, scaleY: orig.scaleY * v }); render(); },
          onComplete: () => obj.set({ scaleX: orig.scaleX, scaleY: orig.scaleY }),
        });
        break;
      case "zoom-out":
        obj.set({ scaleX: orig.scaleX * 2, scaleY: orig.scaleY * 2, opacity: 0 });
        tween({
          startValue: 2, endValue: 1, duration: dur, easing: ease.easeOutCubic,
          onChange: (v: number) => {
            obj.set({ scaleX: orig.scaleX * v, scaleY: orig.scaleY * v, opacity: Math.min(1, (2 - v)) });
            render();
          },
          onComplete: () => obj.set({ scaleX: orig.scaleX, scaleY: orig.scaleY, opacity: orig.opacity }),
        });
        break;
      case "spin":
        tween({
          startValue: 0, endValue: 360, duration: dur,
          onChange: (v: number) => { obj.set("angle", (orig.angle + v) % 360); render(); },
          onComplete: () => obj.set("angle", orig.angle),
        });
        break;
      case "pulse": {
        const half = dur / 2;
        (fabric as any).util.animate({
          startValue: 1, endValue: 1.2, duration: half, easing: ease.easeInOutQuad,
          onChange: (v: number) => { obj.set({ scaleX: orig.scaleX * v, scaleY: orig.scaleY * v }); render(); },
          onComplete: () => {
            tween({
              startValue: 1.2, endValue: 1, duration: half, easing: ease.easeInOutQuad,
              onChange: (v: number) => { obj.set({ scaleX: orig.scaleX * v, scaleY: orig.scaleY * v }); render(); },
              onComplete: () => obj.set({ scaleX: orig.scaleX, scaleY: orig.scaleY }),
            });
          },
        });
        break;
      }
      case "bounce": {
        const startTop = orig.top - 80;
        obj.set({ top: startTop, opacity: 0 });
        (fabric as any).util.animate({
          startValue: 0, endValue: orig.opacity, duration: Math.min(300, dur / 2),
          onChange: (v: number) => { obj.set("opacity", v); render(); },
        });
        tween({
          startValue: startTop, endValue: orig.top, duration: dur, easing: ease.easeOutBounce,
          onChange: (v: number) => { obj.set("top", v); obj.setCoords(); render(); },
          onComplete: () => { obj.set({ top: orig.top, opacity: orig.opacity }); obj.setCoords(); },
        });
        break;
      }
      case "slideshow":
        // Slideshow is a continuous frame-cycler — runs on its own loop and
        // ignores the outer driver loop below.
        playSlideshow(fc, obj, fabric, anim);
        return;
    }
  };

  const loop = anim.loop;
  const driver = () => runOnce(loop ? () => setTimeout(driver, 200) : undefined);
  if (delay > 0) setTimeout(driver, delay); else driver();
}

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
    templateId: typeof s.templateId === "string" ? s.templateId : undefined,
    image: typeof s.image === "string" ? s.image : undefined,
    companyId: typeof s.companyId === "string" ? s.companyId : undefined,
    returnUrl: typeof s.returnUrl === "string" ? s.returnUrl : undefined,
  }),
});

function EditorPage() {
  const { template, templateId: legacyTemplateId, image: imageIdParam, returnUrl: returnUrlParam } = Route.useSearch();
  const templateIdParam = template ?? legacyTemplateId;
  const params = new URLSearchParams(window.location.search);
  const externalCompanyId = params.get("companyId") || undefined;
  // External-launch mode (Nini Signage Renderer): bypass Supabase auth and
  // write media directly to the customer Firebase project.
  const externalMode = !!(templateIdParam && externalCompanyId);
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

  // companyId for the logged-in user, used so that uploadEditedMediaToFirebase
  // can tell the Cloud Function to mirror processed media into the
  // `companies/{companyId}/media/{mediaId}` doc the Android player reads.
  const [loggedInCompanyId, setLoggedInCompanyId] = useState<string | null>(null);
  useEffect(() => {
    if (externalMode) return;
    let cancelled = false;
    getSignageSettings()
      .then((res) => {
        if (cancelled) return;
        const cid = (res?.settings as { company_id?: string | null } | null | undefined)?.company_id;
        if (cid) setLoggedInCompanyId(cid);
      })
      .catch(() => {
        /* fine — uploads still work without a companyId, they just won't mirror */
      });
    return () => {
      cancelled = true;
    };
  }, [externalMode]);

  // Drawing / shape tool state
  type Tool = "select" | "draw" | "eraser" | "line" | "arrow";
  const [tool, setTool] = useState<Tool>("select");
  const [brushColor, setBrushColor] = useState("#111827");
  const [brushSize, setBrushSize] = useState(8);
  const [showRulers, setShowRulers] = useState(true);

  const resolveOwnerId = useCallback(async () => {
    if (externalCompanyId) return externalCompanyId;
    const { data: ud } = await supabase.auth.getUser();
    return ud.user?.id;
  }, [externalCompanyId]);

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
    if (externalMode) {
      // In external-launch mode we don't have a Supabase row for the
      // template; just use the id from the URL and start with a blank canvas.
      setTemplateId(templateIdParam);
      return;
    }
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
  }, [templateIdParam, imageIdParam, loadGalleryImageAsTemplate, withFreshImageUrls, externalMode]);

  // Fall back to the rendered gallery image when the row has no editable template yet
  useEffect(() => {
    if (!imageIdParam || templateIdParam || externalMode) return;
    void loadGalleryImageAsTemplate(imageIdParam);
  }, [imageIdParam, templateIdParam, loadGalleryImageAsTemplate, externalMode]);

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
    const clipboard: { ref: any } = { ref: null };
    const doCopy = async () => {
      const fc = fcRef.current; if (!fc) return;
      const o = fc.getActiveObject(); if (!o) return;
      clipboard.ref = await o.clone(["imageStoragePath", "squareBinding", "videoStoragePath", "videoSrc", "animation", "slideshowImages"] as any);
    };
    const doPaste = async () => {
      const fc = fcRef.current; if (!fc || !clipboard.ref) return;
      const c = await clipboard.ref.clone(["imageStoragePath", "squareBinding", "videoStoragePath", "videoSrc", "animation", "slideshowImages"] as any);
      c.set({ left: (c.left ?? 0) + 30, top: (c.top ?? 0) + 30, evented: true });
      if (c.type === "activeselection" || c.type === "activeSelection") {
        c.canvas = fc;
        c.forEachObject?.((o: any) => fc.add(o));
        c.setCoords?.();
      } else {
        fc.add(c);
      }
      fc.setActiveObject(c);
      fc.requestRenderAll();
      fc.fire("object:modified", { target: c } as any);
    };
    const onKey = (e: KeyboardEvent) => {
      const fc = fcRef.current; if (!fc) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      const obj = fc.getActiveObject();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); void doPaste(); return; }
      if (!obj) return;
      // Don't intercept while editing text
      if ((obj as any).isEditing) return;
      if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); void doCopy(); return; }
      if (mod && (e.key === "x" || e.key === "X")) {
        e.preventDefault();
        void doCopy().then(() => {
          const objs = fc.getActiveObjects();
          objs.forEach((o) => fc.remove(o));
          fc.discardActiveObject();
          fc.requestRenderAll();
        });
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        void doCopy().then(doPaste);
        return;
      }
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
    if (externalMode) return;
    (async () => {
      const { data } = await supabase
        .from("square_items_cache")
        .select("square_item_id, name, description, price_cents, currency")
        .order("name", { ascending: true });
      setSquareItems((data ?? []) as SquareCacheItem[]);
    })();
  }, [externalMode]);

  // Layer Firebase-sourced Square catalog on top of the Supabase cache.
  // When Firebase items load, they replace the cache entries. Editor stays
  // usable when Firebase is unconfigured or offline (hook returns []).
  // In external-launch mode, Square data is scoped to the customer's
  // `companies/{companyId}` doc (squareMenuUrl, square_items subcollection,
  // company-scoped sync state). Outside external mode the hooks fall back
  // to the legacy global Firestore paths.
  const squareScopeCompanyId = externalMode ? externalCompanyId ?? null : null;
  const { items: firebaseItems } = useSquareCatalog(squareScopeCompanyId);
  const { state: squareSyncState } = useSquareSyncState(squareScopeCompanyId);
  const { trigger: triggerSquareSync, running: squareSyncRunning } = useTriggerSquareSync(squareScopeCompanyId);
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
  useEffect(() => { if (!externalMode) void loadAssets(); }, [externalMode]);
  useEffect(() => { if (!externalMode) void loadCustomFonts(); }, [externalMode]);

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
    const ownerId = await resolveOwnerId();
    if (!ownerId) return;
    const { data } = await supabase.storage.from("fonts").list(ownerId, { limit: 100 });
    if (!data) return;
    for (const f of data) {
      const path = `${ownerId}/${f.name}`;
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
      const ownerId = await resolveOwnerId();
      if (!ownerId) { toast.error("Sign in required"); return; }
      const safe = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${ownerId}/${safe}`;
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
    const ownerId = await resolveOwnerId();
    if (!ownerId) return;
    const { data } = await supabase.from("images").select("id, title, variants").eq("user_id", ownerId).order("created_at", { ascending: false }).limit(50);
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
    const canvasJson = (fc as any).toObject(["imageStoragePath", "squareBinding", "videoStoragePath", "videoSrc", "animation", "slideshowImages"]);
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
      if (externalMode) {
        const res = await uploadCompanyMedia({
          companyId: externalCompanyId!,
          templateId: templateIdParam!,
          kind: "image",
          blob: file,
          contentType: file.type || "image/png",
          name: file.name,
        });
        toast.dismiss(tId);
        await addImageFromUrl(res.url, res.path);
        return;
      }
      const res = await uploadEditedMediaToFirebase({
        kind: "image",
        blob: file,
        contentType: file.type || "image/png",
        name: file.name,
        companyId: loggedInCompanyId,
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

  /** Upload a single file and return its hosted URL+path, without placing it
   *  on the canvas. Used by slideshow frame uploads. */
  const uploadImageFile = async (file: File): Promise<{ url: string; path: string } | null> => {
    const tId = toast.loading("Uploading image…");
    try {
      if (externalMode) {
        const res = await uploadCompanyMedia({
          companyId: externalCompanyId!,
          templateId: templateIdParam!,
          kind: "image",
          blob: file,
          contentType: file.type || "image/png",
          name: file.name,
        });
        toast.success("Image added", { id: tId });
        return { url: res.url, path: res.path };
      }
      const res = await uploadEditedMediaToFirebase({
        kind: "image",
        blob: file,
        contentType: file.type || "image/png",
        name: file.name,
        companyId: loggedInCompanyId,
      });
      toast.loading("Processing image…", { id: tId });
      const ready = await waitForMediaReady(res.mediaDocId).catch(() => null);
      const finalUrl = (ready?.url as string) || res.url;
      const finalPath = (ready?.path as string) || res.path;
      toast.success("Image added", { id: tId });
      return { url: finalUrl, path: finalPath };
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Image upload failed", { id: tId });
      return null;
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
      if (externalMode) {
        const res = await uploadCompanyMedia({
          companyId: externalCompanyId!,
          templateId: templateIdParam!,
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
        toast.success("Video ready", { id: tId });
        try { await addVideoFromUrl(res.url, res.path); }
        catch (err) { toast.error(err instanceof Error ? err.message : "Could not place video"); }
        return;
      }
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
        companyId: loggedInCompanyId,
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

  const addEllipse = () => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const { w, h } = getCanvasSize(preset);
    const o = new fabric.Ellipse({ left: w / 2 - 180, top: h / 2 - 100, rx: 180, ry: 100, fill: "#3b82f6" });
    fc.add(o); fc.setActiveObject(o); fc.renderAll();
  };
  const addStar = (points = 5) => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const { w, h } = getCanvasSize(preset);
    const outer = 150, inner = 70;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (Math.PI / points) * i - Math.PI / 2;
      pts.push({ x: Math.cos(a) * r + outer, y: Math.sin(a) * r + outer });
    }
    const o = new fabric.Polygon(pts, { left: w / 2 - outer, top: h / 2 - outer, fill: "#f59e0b" });
    fc.add(o); fc.setActiveObject(o); fc.renderAll();
  };
  const addPolygon = (sides = 6) => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const { w, h } = getCanvasSize(preset);
    const r = 140;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (Math.PI * 2 / sides) * i - Math.PI / 2;
      pts.push({ x: Math.cos(a) * r + r, y: Math.sin(a) * r + r });
    }
    const o = new fabric.Polygon(pts, { left: w / 2 - r, top: h / 2 - r, fill: "#10b981" });
    fc.add(o); fc.setActiveObject(o); fc.renderAll();
  };
  const addLine = () => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const { w, h } = getCanvasSize(preset);
    const o = new fabric.Line([w / 2 - 200, h / 2, w / 2 + 200, h / 2], { stroke: brushColor, strokeWidth: Math.max(2, brushSize) });
    fc.add(o); fc.setActiveObject(o); fc.renderAll();
  };
  const addArrow = () => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const { w, h } = getCanvasSize(preset);
    const sw = Math.max(2, brushSize);
    const len = 360;
    const x1 = w / 2 - len / 2, y = h / 2, x2 = w / 2 + len / 2;
    const line = new fabric.Line([x1, y, x2 - 18, y], { stroke: brushColor, strokeWidth: sw });
    const head = new fabric.Triangle({ left: x2, top: y, originX: "center", originY: "center", angle: 90, width: 24, height: 28, fill: brushColor });
    const grp = new fabric.Group([line, head], { left: x1, top: y - 14 });
    fc.add(grp); fc.setActiveObject(grp); fc.renderAll();
  };

  // Apply drawing tool to fabric canvas
  useEffect(() => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    if (tool === "draw" || tool === "eraser") {
      fc.isDrawingMode = true;
      const brush = new fabric.PencilBrush(fc);
      brush.color = tool === "eraser" ? (bgColor || "#ffffff") : brushColor;
      brush.width = brushSize;
      fc.freeDrawingBrush = brush;
    } else {
      fc.isDrawingMode = false;
    }
  }, [tool, brushColor, brushSize, bgColor, fabric]);

  // Interactive line / arrow drawing
  useEffect(() => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    if (tool !== "line" && tool !== "arrow") return;
    let drawing = false;
    let obj: any = null;
    const onDown = (e: any) => {
      const pt = (fc as any).getScenePoint ? (fc as any).getScenePoint(e.e) : (fc as any).getPointer(e.e);
      drawing = true;
      obj = new fabric.Line([pt.x, pt.y, pt.x, pt.y], {
        stroke: brushColor,
        strokeWidth: Math.max(2, brushSize),
        selectable: false,
        evented: false,
      });
      (obj as any)._isArrowTool = tool === "arrow";
      fc.add(obj);
    };
    const onMove = (e: any) => {
      if (!drawing || !obj) return;
      const pt = (fc as any).getScenePoint ? (fc as any).getScenePoint(e.e) : (fc as any).getPointer(e.e);
      obj.set({ x2: pt.x, y2: pt.y });
      fc.requestRenderAll();
    };
    const onUp = () => {
      if (!drawing || !obj) return;
      drawing = false;
      obj.set({ selectable: true, evented: true });
      if (tool === "arrow") {
        const line = obj as Fabric.Line;
        const x1 = line.x1!, y1 = line.y1!, x2 = line.x2!, y2 = line.y2!;
        fc.remove(line);
        const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        const ln = new fabric.Line([x1, y1, x2, y2], { stroke: brushColor, strokeWidth: Math.max(2, brushSize) });
        const head = new fabric.Triangle({
          left: x2, top: y2, originX: "center", originY: "center",
          angle: angle + 90, width: 22, height: 26, fill: brushColor,
        });
        const grp = new fabric.Group([ln, head]);
        fc.add(grp);
        fc.setActiveObject(grp);
      } else {
        fc.setActiveObject(obj);
      }
      obj = null;
      fc.requestRenderAll();
      setTool("select");
    };
    fc.on("mouse:down", onDown);
    fc.on("mouse:move", onMove);
    fc.on("mouse:up", onUp);
    return () => {
      fc.off("mouse:down", onDown);
      fc.off("mouse:move", onMove);
      fc.off("mouse:up", onUp);
    };
  }, [tool, brushColor, brushSize, fabric]);

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
      const canvasJson = (fc as any).toObject(["imageStoragePath", "squareBinding", "videoStoragePath", "videoSrc", "animation", "slideshowImages"]);
      patchSerializedMedia(canvasJson.objects, fc.getObjects());
      applyCanvasDisplayZoom(fc, w, h, prevZoom);

      const blob = await (await fetch(dataUrl)).blob();
      const { best, variants, originalSize, width: imageWidth, height: imageHeight } = await autoCompress(blob);

      // External-launch mode: upload directly to the customer Firebase
      // project and redirect back to the Nini Renderer with the new media.
      if (externalMode) {
        const res = await uploadCompanyMedia({
          companyId: externalCompanyId!,
          templateId: templateIdParam!,
          kind: "image",
          blob: best.blob,
          contentType: best.blob.type || "image/png",
          name: title,
          width: imageWidth,
          height: imageHeight,
        });
        toast.success(
          `Saved! Compressed ${Math.round((1 - best.size / originalSize) * 100)}%`,
        );
        if (returnUrlParam) {
          redirectToReturnUrl(returnUrlParam, {
            mediaDocId: res.mediaDocId,
            url: res.url,
            thumbnailURL: res.thumbnailURL,
          });
        }
        return;
      }

      const ownerId = await resolveOwnerId();
      if (!ownerId) { toast.error("Sign in required"); return; }

      // Persist editable template (insert or update)
      let savedTemplateId = templateId;
      const tplPayload = {
        user_id: ownerId,
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
        ? await supabase.from("images").select("id, slug").eq("user_id", ownerId).eq("id", imageIdParam).maybeSingle()
        : savedTemplateId
          ? await supabase
              .from("images")
              .select("id, slug")
              .eq("user_id", ownerId)
              .eq("template_id", savedTemplateId)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle()
          : { data: null };
      const slug = existingImage?.slug ?? nanoid(10);
      const baseFolder = `${ownerId}/${slug}`;
      const variantRecords: { format: string; path: string; size: number; quality: number }[] = [];
      for (const v of variants) {
        const path = `${baseFolder}/image.${v.format === "jpeg" ? "jpg" : v.format}`;
        const { error } = await supabase.storage.from("images").upload(path, v.blob, { contentType: v.blob.type, upsert: true });
        if (error) throw error;
        variantRecords.push({ format: v.format, path, size: v.size, quality: v.quality });
      }
      variantRecords.sort((x, y) => x.size - y.size);

      const imagePayload = {
        user_id: ownerId, slug, title, width: imageWidth, height: imageHeight,
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
              <div className="grid grid-cols-4 gap-2">
                <Button variant="outline" onClick={() => addShape("rect")} title="Rectangle"><SquareIcon className="size-4" /></Button>
                <Button variant="outline" onClick={() => addShape("circle")} title="Circle"><CircleIcon className="size-4" /></Button>
                <Button variant="outline" onClick={() => addShape("triangle")} title="Triangle"><TriangleIcon className="size-4" /></Button>
                <Button variant="outline" onClick={addEllipse} title="Ellipse"><CircleIcon className="size-4" style={{ transform: "scaleX(1.5)" }} /></Button>
                <Button variant="outline" onClick={() => addStar(5)} title="Star"><Star className="size-4" /></Button>
                <Button variant="outline" onClick={() => addPolygon(6)} title="Hexagon"><Hexagon className="size-4" /></Button>
                <Button variant="outline" onClick={addLine} title="Line"><Minus className="size-4" /></Button>
                <Button variant="outline" onClick={addArrow} title="Arrow"><MoveUpRight className="size-4" /></Button>
              </div>
              <Separator />
              <Label className="text-xs">Tools</Label>
              <div className="grid grid-cols-5 gap-1">
                <Button variant={tool === "select" ? "default" : "outline"} size="sm" onClick={() => setTool("select")} title="Select"><MousePointer2 className="size-4" /></Button>
                <Button variant={tool === "draw" ? "default" : "outline"} size="sm" onClick={() => setTool("draw")} title="Paint brush"><Pencil className="size-4" /></Button>
                <Button variant={tool === "eraser" ? "default" : "outline"} size="sm" onClick={() => setTool("eraser")} title="Eraser"><Eraser className="size-4" /></Button>
                <Button variant={tool === "line" ? "default" : "outline"} size="sm" onClick={() => setTool("line")} title="Draw line"><Minus className="size-4" /></Button>
                <Button variant={tool === "arrow" ? "default" : "outline"} size="sm" onClick={() => setTool("arrow")} title="Draw arrow"><MoveUpRight className="size-4" /></Button>
              </div>
              {(tool === "draw" || tool === "eraser" || tool === "line" || tool === "arrow") && (
                <div className="space-y-2 rounded border border-border p-2">
                  <div>
                    <Label className="text-xs">Size ({brushSize}px)</Label>
                    <Slider min={1} max={80} step={1} value={[brushSize]} onValueChange={(v) => setBrushSize(v[0])} className="mt-2" />
                  </div>
                  {tool !== "eraser" && (
                    <div>
                      <Label className="text-xs">Color</Label>
                      <div className="flex gap-2 mt-1">
                        <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} className="h-8 w-10 rounded border border-border bg-transparent cursor-pointer" />
                        <Input value={brushColor} onChange={(e) => setBrushColor(e.target.value)} className="flex-1 h-8" />
                      </div>
                    </div>
                  )}
                </div>
              )}
              <Button variant={showRulers ? "default" : "outline"} size="sm" className="w-full" onClick={() => setShowRulers((v) => !v)}>
                <Ruler className="size-4 mr-2" /> {showRulers ? "Hide rulers" : "Show rulers"}
              </Button>
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
              <p className="text-[10px] text-muted-foreground px-1 pb-1">Top of list = front of canvas</p>
              {[...objects].reverse().map((obj, idx) => {
                const realIdx = objects.length - 1 - idx;
                const label = obj instanceof fabric.IText || obj instanceof fabric.Textbox
                  ? `T  ${(obj.text || "").slice(0, 20) || "Text"}`
                  : obj instanceof fabric.FabricImage ? "🖼  Image"
                  : obj instanceof fabric.Circle ? "○  Circle"
                  : obj instanceof fabric.Triangle ? "△  Triangle"
                  : obj instanceof fabric.Line ? "—  Line"
                  : obj instanceof fabric.Polygon ? "✦  Polygon"
                  : obj instanceof fabric.Path ? "✎  Drawing"
                  : obj instanceof fabric.Group ? "▣  Group" : "▭  Shape";
                const isActive = a === obj;
                const isTop = idx === 0;
                const isBottom = idx === objects.length - 1;
                return (
                  <div key={realIdx} className={`group flex items-center gap-1 px-2 py-1.5 rounded text-sm cursor-pointer ${isActive ? "bg-accent" : "hover:bg-accent/50"}`}
                    onClick={() => { fcRef.current?.setActiveObject(obj); fcRef.current?.renderAll(); refresh(); }}>
                    <button title={obj.visible !== false ? "Hide" : "Show"} onClick={(e) => { e.stopPropagation(); obj.visible = !obj.visible; fcRef.current?.renderAll(); refresh(); }} className="text-muted-foreground hover:text-foreground">
                      {obj.visible !== false ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                    </button>
                    <span className="flex-1 truncate">{label}</span>
                    <button title="Bring forward" disabled={isTop}
                      onClick={(e) => { e.stopPropagation(); const fc = fcRef.current; if (!fc) return; fc.bringObjectForward(obj); fc.renderAll(); pushHistory(); refresh(); }}
                      className="opacity-60 hover:opacity-100 disabled:opacity-20 text-muted-foreground hover:text-foreground">
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button title="Send backward" disabled={isBottom}
                      onClick={(e) => { e.stopPropagation(); const fc = fcRef.current; if (!fc) return; fc.sendObjectBackwards(obj); fc.renderAll(); pushHistory(); refresh(); }}
                      className="opacity-60 hover:opacity-100 disabled:opacity-20 text-muted-foreground hover:text-foreground">
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button title="Duplicate"
                      onClick={async (e) => { e.stopPropagation(); const fc = fcRef.current; if (!fc) return; const c = await obj.clone(); c.set({ left: (obj.left ?? 0) + 30, top: (obj.top ?? 0) + 30 }); fc.add(c); fc.setActiveObject(c); fc.renderAll(); }}
                      className="opacity-60 hover:opacity-100 text-muted-foreground hover:text-foreground">
                      <Copy className="size-3.5" />
                    </button>
                    <button title="Delete"
                      onClick={(e) => { e.stopPropagation(); const fc = fcRef.current; if (!fc) return; fc.remove(obj); fc.discardActiveObject(); fc.renderAll(); }}
                      className="opacity-60 hover:opacity-100 text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
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
              let items: SquareCacheItem[] = [];
              if (externalMode) {
                // External launch: use the Firebase catalog already
                // streaming into `firebaseItems` from
                // companies/{companyId}/square_items.
                items = firebaseItems.map((it) => {
                  const primary = it.variations?.[0];
                  return {
                    square_item_id: it.squareItemId,
                    name: it.name || null,
                    description: it.description ?? null,
                    price_cents: primary?.priceCents ?? null,
                    currency: primary?.currency ?? null,
                  };
                });
              } else {
                const { data } = await supabase
                  .from("square_items_cache")
                  .select("square_item_id, name, description, price_cents, currency")
                  .order("name", { ascending: true });
                items = (data ?? []) as SquareCacheItem[];
              }
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
          <div className="inline-block relative" style={{ paddingTop: showRulers ? 22 : 0, paddingLeft: showRulers ? 22 : 0 }}>
            {showRulers && <Rulers preset={preset} zoom={zoom} />}
            <div className="bg-white shadow-[var(--shadow-elegant)] inline-block relative">
              <canvas ref={canvasRef} />
              {showRulers && <CenterGuides preset={preset} zoom={zoom} />}
            </div>
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

            {a && fabric && (
              <AnimationPanel
                object={a}
                isImage={isImage}
                onChange={() => { pushHistory(); refresh(); }}
                onPreview={() => { const fc = fcRef.current; if (fc) playObjectAnimation(fc, a as any, fabric); }}
                onStopSlideshow={() => { stopSlideshow(a as any); fcRef.current?.requestRenderAll(); }}
                onAddSlideshowFrame={async (file) => {
                  const r = await uploadImageFile(file);
                  if (!r) return;
                  const arr: SlideshowFrame[] = Array.isArray((a as any).slideshowImages) ? (a as any).slideshowImages : [];
                  (a as any).slideshowImages = [...arr, { url: r.url, path: r.path }];
                  pushHistory(); refresh();
                }}
                onRemoveSlideshowFrame={(idx) => {
                  const arr: SlideshowFrame[] = Array.isArray((a as any).slideshowImages) ? (a as any).slideshowImages : [];
                  (a as any).slideshowImages = arr.filter((_, i) => i !== idx);
                  pushHistory(); refresh();
                }}
              />
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

function Rulers({ preset, zoom }: { preset: string; zoom: number }) {
  const { w, h } = getCanvasSize(preset);
  const dispW = w * zoom;
  const dispH = h * zoom;
  // Major tick stays ~100px on-screen; minor = major/5
  const targetPx = 100;
  const candidates = [10, 20, 50, 100, 200, 500, 1000, 2000];
  const major = candidates.find((s) => s * zoom >= targetPx) ?? 2000;
  const minor = Math.max(1, Math.round(major / 5));

  const xMajor: number[] = []; for (let x = 0; x <= w; x += major) xMajor.push(x);
  const yMajor: number[] = []; for (let y = 0; y <= h; y += major) yMajor.push(y);
  const xMinor: number[] = []; for (let x = 0; x <= w; x += minor) if (x % major !== 0) xMinor.push(x);
  const yMinor: number[] = []; for (let y = 0; y <= h; y += minor) if (y % major !== 0) yMinor.push(y);

  const cx = w / 2, cy = h / 2;

  return (
    <>
      {/* Top ruler */}
      <div
        className="absolute top-0 bg-muted border-b border-border text-[9px] text-muted-foreground select-none overflow-hidden"
        style={{ left: 22, width: dispW, height: 22 }}
      >
        {xMinor.map((x) => (
          <div key={`mn-${x}`} className="absolute bottom-0 w-px bg-border/60" style={{ left: x * zoom, height: 5 }} />
        ))}
        {xMajor.map((x) => (
          <div key={`mj-${x}`} className="absolute bottom-0 w-px bg-foreground/40" style={{ left: x * zoom, height: 10 }}>
            <span className="absolute -top-[1px] left-1 leading-none tabular-nums">{x}</span>
          </div>
        ))}
        {/* Center marker */}
        <div className="absolute bottom-0 w-px bg-pink-500" style={{ left: cx * zoom, height: 14 }}>
          <span className="absolute -top-[1px] left-1 leading-none text-pink-600 font-medium">{cx}</span>
        </div>
      </div>

      {/* Left ruler */}
      <div
        className="absolute left-0 bg-muted border-r border-border text-[9px] text-muted-foreground select-none overflow-hidden"
        style={{ top: 22, height: dispH, width: 22 }}
      >
        {yMinor.map((y) => (
          <div key={`mn-${y}`} className="absolute right-0 h-px bg-border/60" style={{ top: y * zoom, width: 5 }} />
        ))}
        {yMajor.map((y) => (
          <div key={`mj-${y}`} className="absolute right-0 h-px bg-foreground/40" style={{ top: y * zoom, width: 10 }}>
            <span
              className="absolute right-2.5 top-0 leading-none tabular-nums"
              style={{ transform: "rotate(-90deg)", transformOrigin: "right top" }}
            >{y}</span>
          </div>
        ))}
        {/* Center marker */}
        <div className="absolute right-0 h-px bg-pink-500" style={{ top: cy * zoom, width: 14 }}>
          <span
            className="absolute right-3.5 top-0 leading-none text-pink-600 font-medium"
            style={{ transform: "rotate(-90deg)", transformOrigin: "right top" }}
          >{cy}</span>
        </div>
      </div>

      {/* Corner */}
      <div className="absolute top-0 left-0 bg-muted border-r border-b border-border" style={{ width: 22, height: 22 }} />
    </>
  );
}

// Crosshair overlay rendered above the fabric canvas: center + thirds.
function CenterGuides({ preset, zoom }: { preset: string; zoom: number }) {
  const { w, h } = getCanvasSize(preset);
  const dispW = w * zoom;
  const dispH = h * zoom;
  return (
    <div className="pointer-events-none absolute inset-0" style={{ width: dispW, height: dispH }}>
      {/* Rule-of-thirds (subtle) */}
      <div className="absolute top-0 bottom-0 border-l border-dashed border-foreground/15" style={{ left: dispW / 3 }} />
      <div className="absolute top-0 bottom-0 border-l border-dashed border-foreground/15" style={{ left: (dispW / 3) * 2 }} />
      <div className="absolute left-0 right-0 border-t border-dashed border-foreground/15" style={{ top: dispH / 3 }} />
      <div className="absolute left-0 right-0 border-t border-dashed border-foreground/15" style={{ top: (dispH / 3) * 2 }} />
      {/* Center cross (pink) */}
      <div className="absolute top-0 bottom-0 border-l border-pink-500/60" style={{ left: dispW / 2 }} />
      <div className="absolute left-0 right-0 border-t border-pink-500/60" style={{ top: dispH / 2 }} />
      {/* Center dot */}
      <div
        className="absolute rounded-full bg-pink-500"
        style={{ left: dispW / 2 - 3, top: dispH / 2 - 3, width: 6, height: 6 }}
      />
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

function AnimationPanel({
  object,
  isImage,
  onChange,
  onPreview,
  onStopSlideshow,
  onAddSlideshowFrame,
  onRemoveSlideshowFrame,
}: {
  object: Fabric.Object;
  isImage: boolean;
  onChange: () => void;
  onPreview: () => void;
  onStopSlideshow: () => void;
  onAddSlideshowFrame: (file: File) => Promise<void> | void;
  onRemoveSlideshowFrame: (idx: number) => void;
}) {
  const anim: ObjectAnimation = ((object as any).animation as ObjectAnimation | undefined) ?? { type: "none", duration: 1, delay: 0, loop: false };
  const frames: SlideshowFrame[] = Array.isArray((object as any).slideshowImages) ? (object as any).slideshowImages : [];
  const update = (patch: Partial<ObjectAnimation>) => {
    const next: ObjectAnimation = { ...anim, ...patch };
    if (next.type === "none") delete (object as any).animation;
    else (object as any).animation = next;
    onChange();
  };
  // Hide "Slideshow" for non-image layers (it relies on swapping image src).
  const options = isImage ? ANIMATION_OPTIONS : ANIMATION_OPTIONS.filter((o) => o.value !== "slideshow");
  return (
    <div className="space-y-2 rounded border border-border p-2">
      <Label className="text-xs flex items-center gap-1.5"><Sparkles className="size-3" /> Animation</Label>
      <Select value={anim.type} onValueChange={(v) => update({ type: v as AnimationType })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {anim.type !== "none" && (
        <>
          {anim.type !== "slideshow" && (
            <div>
              <Label className="text-xs">Duration ({anim.duration.toFixed(1)}s)</Label>
              <Slider min={0.1} max={5} step={0.1} value={[anim.duration]} onValueChange={(v) => update({ duration: v[0] })} className="mt-2" />
            </div>
          )}
          {anim.type === "slideshow" && (
            <div>
              <Label className="text-xs">Each frame ({(anim.interval ?? 2).toFixed(1)}s)</Label>
              <Slider min={0.5} max={15} step={0.5} value={[anim.interval ?? 2]} onValueChange={(v) => update({ interval: v[0] })} className="mt-2" />
            </div>
          )}
          <div>
            <Label className="text-xs">Delay ({anim.delay.toFixed(1)}s)</Label>
            <Slider min={0} max={5} step={0.1} value={[anim.delay]} onValueChange={(v) => update({ delay: v[0] })} className="mt-2" />
          </div>
          <div className="flex items-center gap-2">
            <Button variant={anim.loop ? "default" : "outline"} size="sm" className="flex-1" onClick={() => update({ loop: !anim.loop })}>
              {anim.loop ? "Looping" : "Loop off"}
            </Button>
            <Button size="sm" className="flex-1" onClick={onPreview}>
              <Play className="size-3.5 mr-1" /> Preview
            </Button>
          </div>
          {anim.type === "slideshow" && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Frames ({frames.length + 1})</Label>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onStopSlideshow}>Stop</Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                The current image is frame 1. Upload more to cycle through.
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {frames.map((f, i) => (
                  <div key={`${f.url}-${i}`} className="relative aspect-square rounded overflow-hidden border border-border group">
                    <img src={f.url} alt="" className="size-full object-cover" />
                    <button
                      onClick={() => onRemoveSlideshowFrame(i)}
                      className="absolute top-0.5 right-0.5 size-5 rounded bg-background/80 text-destructive opacity-0 group-hover:opacity-100 flex items-center justify-center"
                      title="Remove frame"
                    >
                      <Trash2 className="size-3" />
                    </button>
                    <span className="absolute bottom-0.5 left-0.5 text-[10px] bg-background/80 rounded px-1">{i + 2}</span>
                  </div>
                ))}
                <label className="aspect-square rounded border border-dashed border-border flex items-center justify-center cursor-pointer hover:bg-accent">
                  <Plus className="size-4 text-muted-foreground" />
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.currentTarget.value = "";
                      if (f) await onAddSlideshowFrame(f);
                    }}
                  />
                </label>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
