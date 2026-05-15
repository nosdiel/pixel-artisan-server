import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import * as fabric from "fabric";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { autoCompress } from "@/lib/compress";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Upload, Type, Square as SquareIcon, Circle as CircleIcon, RotateCw, FlipHorizontal, FlipVertical, Save, Trash2 } from "lucide-react";

const PRESETS: Record<string, { w: number; h: number; label: string }> = {
  "1920x1080": { w: 1920, h: 1080, label: "1080p Landscape" },
  "3840x2160": { w: 3840, h: 2160, label: "4K Landscape" },
  "1080x1920": { w: 1080, h: 1920, label: "1080p Portrait" },
  "2160x3840": { w: 2160, h: 3840, label: "4K Portrait" },
  "1280x720":  { w: 1280, h: 720,  label: "720p Landscape" },
};

export const Route = createFileRoute("/_authenticated/editor")({ component: EditorPage });

function EditorPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fcRef = useRef<fabric.Canvas | null>(null);
  const [preset, setPreset] = useState("1920x1080");
  const [title, setTitle] = useState("Untitled");
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [saving, setSaving] = useState(false);
  const [bgImg, setBgImg] = useState<fabric.FabricImage | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!canvasRef.current) return;
    const { w, h } = PRESETS[preset];
    const fc = new fabric.Canvas(canvasRef.current, {
      width: w, height: h, backgroundColor: "#ffffff",
    });
    fcRef.current = fc;
    return () => { fc.dispose(); fcRef.current = null; };
  }, [preset]);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !fcRef.current) return;
    const url = URL.createObjectURL(file);
    const img = await fabric.FabricImage.fromURL(url);
    const fc = fcRef.current;
    const scale = Math.min(fc.width! / img.width!, fc.height! / img.height!);
    img.scale(scale);
    img.set({ left: (fc.width! - img.width! * scale) / 2, top: (fc.height! - img.height! * scale) / 2 });
    fc.add(img);
    setBgImg(img);
    fc.renderAll();
  };

  const addText = () => {
    const t = new fabric.IText("Your text", { left: 100, top: 100, fontSize: 64, fill: "#111827", fontFamily: "Inter, sans-serif" });
    fcRef.current?.add(t);
    fcRef.current?.setActiveObject(t);
  };
  const addRect = () => {
    const r = new fabric.Rect({ left: 100, top: 100, width: 300, height: 200, fill: "#3b82f6" });
    fcRef.current?.add(r);
  };
  const addCircle = () => {
    const c = new fabric.Circle({ left: 100, top: 100, radius: 100, fill: "#a855f7" });
    fcRef.current?.add(c);
  };
  const rotate = () => { const o = fcRef.current?.getActiveObject(); if (o) { o.rotate(((o.angle || 0) + 90) % 360); fcRef.current?.renderAll(); } };
  const flipH = () => { const o = fcRef.current?.getActiveObject() as fabric.FabricImage | undefined; if (o) { o.set("flipX", !o.flipX); fcRef.current?.renderAll(); } };
  const flipV = () => { const o = fcRef.current?.getActiveObject() as fabric.FabricImage | undefined; if (o) { o.set("flipY", !o.flipY); fcRef.current?.renderAll(); } };
  const remove = () => { const o = fcRef.current?.getActiveObject(); if (o) { fcRef.current?.remove(o); } };

  const applyFilters = () => {
    if (!bgImg) return;
    bgImg.filters = [
      new fabric.filters.Brightness({ brightness: brightness / 100 }),
      new fabric.filters.Contrast({ contrast: contrast / 100 }),
    ];
    bgImg.applyFilters();
    fcRef.current?.renderAll();
  };
  useEffect(() => { applyFilters(); /* eslint-disable-next-line */ }, [brightness, contrast]);

  const onSave = async () => {
    const fc = fcRef.current;
    if (!fc) return;
    setSaving(true);
    try {
      const dataUrl = fc.toDataURL({ format: "png", multiplier: 1 });
      const blob = await (await fetch(dataUrl)).blob();
      const { best, variants, originalSize, width, height } = await autoCompress(blob);

      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user!.id;
      const slug = nanoid(10);
      const baseFolder = `${userId}/${slug}`;
      const variantRecords: { format: string; path: string; size: number; quality: number }[] = [];
      for (const v of variants) {
        const path = `${baseFolder}/image.${v.format === "jpeg" ? "jpg" : v.format}`;
        const { error } = await supabase.storage.from("images").upload(path, v.blob, { contentType: v.blob.type, upsert: true });
        if (error) throw error;
        variantRecords.push({ format: v.format, path, size: v.size, quality: v.quality });
      }
      // sort so best is first
      variantRecords.sort((a, b) => a.size - b.size);

      const { error: insErr } = await supabase.from("images").insert({
        user_id: userId, slug, title, width, height,
        original_size_bytes: originalSize,
        optimized_size_bytes: best.size,
        variants: variantRecords,
        preset, source: "editor",
      });
      if (insErr) throw insErr;
      toast.success(`Saved! Compressed ${Math.round((1 - best.size / originalSize) * 100)}%`);
      navigate({ to: "/dashboard" });
    } catch (e: any) {
      toast.error(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-screen">
      <div className="w-72 border-r border-border bg-card p-4 space-y-5 overflow-y-auto">
        <h2 className="font-semibold text-lg">Editor</h2>
        <div>
          <Label>Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
        </div>
        <div>
          <Label>Signage preset</Label>
          <Select value={preset} onValueChange={setPreset}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(PRESETS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label} ({v.w}×{v.h})</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label>Background image</Label>
          <label className="mt-1 flex items-center gap-2 px-3 py-2 border border-dashed border-border rounded-md text-sm cursor-pointer hover:bg-accent">
            <Upload className="size-4" /> Upload image
            <input type="file" accept="image/*" className="hidden" onChange={onUpload} />
          </label>
        </div>
        <div className="space-y-2">
          <Label>Add</Label>
          <div className="grid grid-cols-3 gap-2">
            <Button variant="outline" size="sm" onClick={addText}><Type className="size-4" /></Button>
            <Button variant="outline" size="sm" onClick={addRect}><SquareIcon className="size-4" /></Button>
            <Button variant="outline" size="sm" onClick={addCircle}><CircleIcon className="size-4" /></Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label>Transform</Label>
          <div className="grid grid-cols-3 gap-2">
            <Button variant="outline" size="sm" onClick={rotate}><RotateCw className="size-4" /></Button>
            <Button variant="outline" size="sm" onClick={flipH}><FlipHorizontal className="size-4" /></Button>
            <Button variant="outline" size="sm" onClick={flipV}><FlipVertical className="size-4" /></Button>
          </div>
          <Button variant="outline" size="sm" className="w-full" onClick={remove}><Trash2 className="size-4 mr-1" /> Delete selected</Button>
        </div>
        <div>
          <Label>Brightness ({brightness})</Label>
          <Slider min={-100} max={100} step={1} value={[brightness]} onValueChange={(v) => setBrightness(v[0])} className="mt-2" />
        </div>
        <div>
          <Label>Contrast ({contrast})</Label>
          <Slider min={-100} max={100} step={1} value={[contrast]} onValueChange={(v) => setContrast(v[0])} className="mt-2" />
        </div>
        <Button className="w-full" onClick={onSave} disabled={saving}>
          <Save className="size-4 mr-1" /> {saving ? "Saving…" : "Save & compress"}
        </Button>
      </div>
      <div className="flex-1 bg-muted/40 overflow-auto flex items-center justify-center p-8">
        <div className="bg-white shadow-[var(--shadow-elegant)]" style={{ maxWidth: "100%", maxHeight: "100%" }}>
          <canvas ref={canvasRef} style={{ maxWidth: "100%", maxHeight: "70vh", width: "auto", height: "auto" }} />
        </div>
      </div>
    </div>
  );
}