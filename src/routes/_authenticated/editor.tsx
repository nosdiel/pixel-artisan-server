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
import {
  Upload, Type, Square as SquareIcon, Circle as CircleIcon, Triangle as TriangleIcon,
  RotateCw, FlipHorizontal, FlipVertical, Save, Trash2, Copy,
  ArrowUp, ArrowDown, Undo2, Redo2, ZoomIn, ZoomOut, Maximize2,
  Image as ImageIcon, Layers, Eye, EyeOff, Bold, Italic, Underline,
  AlignLeft, AlignCenter, AlignRight, Plus,
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

function presetForImage(width: number, height: number) {
  const exact = Object.entries(PRESETS).find(([, size]) => size.w === width && size.h === height)?.[0];
  if (exact) return exact;
  if (Math.abs(width - height) < Math.max(width, height) * 0.08) return "1080x1080";
  return height > width ? "1080x1920" : "1920x1080";
}

export const Route = createFileRoute("/_authenticated/editor")({
  component: EditorPage,
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    template: typeof s.template === "string" ? s.template : undefined,
    image: typeof s.image === "string" ? s.image : undefined,
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
  const navigate = useNavigate();

  const getFitZoom = useCallback((presetKey = preset) => {
    const host = canvasHostRef.current;
    const { w, h } = PRESETS[presetKey];
    if (!host) return Math.min(0.4, 720 / h, 900 / w);
    const availableWidth = Math.max(host.clientWidth - 64, 320);
    const availableHeight = Math.max(host.clientHeight - 64, 320);
    return Math.max(0.1, Math.min(availableWidth / w, availableHeight / h, 1));
  }, [preset]);

  const withFreshImageUrls = useCallback(async (canvasJson: unknown) => {
    const json = JSON.parse(JSON.stringify(canvasJson)) as Record<string, any>;
    const refreshObject = async (obj: any): Promise<void> => {
      if (!obj || typeof obj !== "object") return;
      const path = typeof obj.imageStoragePath === "string" ? obj.imageStoragePath : typeof obj.src === "string" ? extractStoragePath(obj.src) : null;
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
    const { w, h } = PRESETS[preset];
    const fc = new fabric.Canvas(canvasRef.current, { width: w, height: h, backgroundColor: bgColor, preserveObjectStacking: true });
    fcRef.current = fc;
    const fittedZoom = getFitZoom(preset);
    fc.setZoom(fittedZoom);
    fc.setDimensions({ width: w * fittedZoom, height: h * fittedZoom }, { cssOnly: true });
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

  // Hydrate canvas from saved template JSON once canvas exists
  useEffect(() => {
    const fc = fcRef.current;
    if (!fc || !pendingCanvasJson) return;
    historyRef.current.suspend = true;
    (async () => {
      try {
        await fc.loadFromJSON(pendingCanvasJson as object);
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
        const scale = Math.min(fc.width! / img.width!, fc.height! / img.height!);
        img.scale(scale);
        img.set({
          left: (fc.width! - img.width! * scale) / 2,
          top: (fc.height! - img.height! * scale) / 2,
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
    const { w, h } = PRESETS[preset];
    fc.setZoom(zoom);
    fc.setDimensions({ width: w * zoom, height: h * zoom }, { cssOnly: true });
    fc.requestRenderAll();
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
    const json = JSON.stringify((fc as any).toJSON(["imageStoragePath"]));
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
    const max = Math.min(fc.width! * 0.6, fc.height! * 0.6);
    const scale = Math.min(max / img.width!, max / img.height!, 1);
    img.scale(scale);
    img.set({ left: (fc.width! - img.width! * scale) / 2, top: (fc.height! - img.height! * scale) / 2 });
    if (path) img.set("imageStoragePath", path);
    fc.add(img); fc.setActiveObject(img); fc.renderAll();
  };
  const onUploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const { data: ud } = await supabase.auth.getUser();
    if (!ud.user) return;
    const ext = file.name.split(".").pop()?.toLowerCase() || "png";
    const path = `${ud.user.id}/editor-assets/${nanoid(10)}.${ext}`;
    const { error } = await supabase.storage.from("images").upload(path, file, { contentType: file.type, upsert: true });
    if (error) {
      toast.error(error.message);
      return;
    }
    const { data: signed } = await supabase.storage.from("images").createSignedUrl(path, 3600);
    await addImageFromUrl(signed?.signedUrl ?? URL.createObjectURL(file), path);
    e.target.value = "";
  };
  const addText = () => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const t = new fabric.IText("Your text", {
      left: fc.width! / 2 - 200, top: fc.height! / 2 - 40, fontSize: 80, fill: "#111827",
      fontFamily: "Inter", originX: "left", originY: "top",
    });
    fc.add(t); fc.setActiveObject(t); fc.renderAll();
  };
  const addShape = (kind: "rect" | "circle" | "triangle") => {
    const fc = fcRef.current; if (!fc || !fabric) return;
    const common = { left: fc.width! / 2 - 150, top: fc.height! / 2 - 150, fill: "#3b82f6" };
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
      target.set({ angle: 0, flipX: false, flipY: false, skewX: 0, skewY: 0, originX: "left", originY: "top" });
      const scale = Math.min(fc.width! / target.width!, fc.height! / target.height!);
      target.scale(scale);
      target.set({
        left: (fc.width! - target.width! * scale) / 2,
        top: (fc.height! - target.height! * scale) / 2,
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
      const prevZoom = fc.getZoom();
      fc.setZoom(1);
      fc.setDimensions({ width: fc.width!, height: fc.height! }, { cssOnly: true });
      const dataUrl = fc.toDataURL({ format: "png", multiplier: 1 });
      const canvasJson = (fc as any).toJSON(["imageStoragePath"]);
      fc.setZoom(prevZoom);
      fc.setDimensions({ width: fc.width! * prevZoom, height: fc.height! * prevZoom }, { cssOnly: true });

      const blob = await (await fetch(dataUrl)).blob();
      const { best, variants, originalSize, width, height } = await autoCompress(blob);
      const { data: ud } = await supabase.auth.getUser();
      const userId = ud.user!.id;

      // Persist editable template (insert or update)
      let savedTemplateId = templateId;
      const tplPayload = {
        user_id: userId,
        name: title,
        preset,
        width,
        height,
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
        user_id: userId, slug, title, width, height,
        original_size_bytes: originalSize, optimized_size_bytes: best.size,
        variants: variantRecords, preset, source: "editor",
        template_id: savedTemplateId,
      };
      const { error: insErr } = existingImage
        ? await supabase.from("images").update(imagePayload).eq("id", existingImage.id)
        : await supabase.from("images").insert(imagePayload);
      if (insErr) throw insErr;
      toast.success(`Saved! Compressed ${Math.round((1 - best.size / originalSize) * 100)}%`);
      navigate({ to: "/dashboard" });
    } catch (e: any) {
      toast.error(e.message || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="flex h-screen bg-muted/30">
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
                  <Label className="text-xs">Font</Label>
                  <Select value={(a as Fabric.IText).fontFamily as string} onValueChange={(v) => update(() => (a as Fabric.IText).set("fontFamily", v))}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>{FONTS.map((f) => <SelectItem key={f} value={f} style={{ fontFamily: f }}>{f}</SelectItem>)}</SelectContent>
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
