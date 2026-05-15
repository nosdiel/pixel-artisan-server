import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Plus, ImageOff, Pencil, Trash2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

type ImageRow = { id: string; slug: string; title: string; width: number; height: number; optimized_size_bytes: number; original_size_bytes: number; variants: { format: string; path: string }[]; created_at: string; template_id: string | null };

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
  ssr: false,
});

function Dashboard() {
  const [images, setImages] = useState<ImageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (img: ImageRow) => {
    setDeletingId(img.id);
    const paths = (img.variants ?? []).map((v) => v.path).filter(Boolean);
    if (paths.length) {
      await supabase.storage.from("images").remove(paths);
    }
    const { error } = await supabase.from("images").delete().eq("id", img.id);
    setDeletingId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setImages((prev) => prev.filter((i) => i.id !== img.id));
    toast.success("Image deleted");
  };

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("images").select("*").order("created_at", { ascending: false });
      if (!error && data) {
        const rows = data as unknown as ImageRow[];
        setImages(rows);
        // sign URLs for thumbnails
        const urls: Record<string, string> = {};
        await Promise.all(rows.map(async (img) => {
          const v = img.variants?.[0];
          if (v) {
            const { data: u } = await supabase.storage.from("images").createSignedUrl(v.path, 3600);
            if (u?.signedUrl) urls[img.id] = u.signedUrl;
          }
        }));
        setThumbs(urls);
      }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">Gallery</h1>
          <p className="text-muted-foreground text-sm mt-1">Your compressed signage images</p>
        </div>
        <Link to="/editor"><Button><Plus className="size-4 mr-1" /> New image</Button></Link>
      </div>

      {loading ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : images.length === 0 ? (
        <div className="border-2 border-dashed border-border rounded-xl p-16 text-center">
          <ImageOff className="size-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium">No images yet</p>
          <p className="text-sm text-muted-foreground mb-4">Upload or design your first signage image.</p>
          <Link to="/editor"><Button>Open editor</Button></Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {images.map((img) => {
            const saved = img.original_size_bytes > 0 ? Math.round((1 - img.optimized_size_bytes / img.original_size_bytes) * 100) : 0;
            return (
              <div key={img.id} className="rounded-xl border border-border bg-card overflow-hidden shadow-[var(--shadow-card)]">
                <div className="aspect-video bg-muted overflow-hidden">
                  {thumbs[img.id] && <img src={thumbs[img.id]} alt={img.title} className="w-full h-full object-cover" />}
                </div>
                <div className="p-3">
                  <div className="font-medium truncate text-sm">{img.title}</div>
                  <div className="text-xs text-muted-foreground mt-1 flex justify-between">
                    <span>{img.width}×{img.height}</span>
                    <span className="text-success">−{saved}%</span>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <Link
                      to="/editor"
                      search={img.template_id ? { template: img.template_id, image: img.id } : { image: img.id }}
                      className="flex-1"
                    >
                      <Button variant="outline" size="sm" className="w-full">
                        <Pencil className="size-3.5 mr-1.5" /> {img.template_id ? "Edit" : "Use as template"}
                      </Button>
                    </Link>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" disabled={deletingId === img.id} aria-label="Delete image">
                          <Trash2 className="size-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this image?</AlertDialogTitle>
                          <AlertDialogDescription>
                            "{img.title}" will be permanently removed from your gallery and storage. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleDelete(img)}>Delete</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}