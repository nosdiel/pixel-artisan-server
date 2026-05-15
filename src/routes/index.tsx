import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ImageIcon, Sparkles, Zap, Cloud, Code2, ShoppingBag, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Pixelboard — Image compression & editor for digital signage" },
      { name: "description", content: "Compress, edit, and auto-update digital signage images. Built-in editor, public API, and Square menu price sync." },
    ],
  }),
});

function Index() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 backdrop-blur sticky top-0 z-40 bg-background/80">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <div className="size-8 rounded-lg" style={{ background: "var(--gradient-primary)" }} />
            <span>Pixelboard</span>
          </Link>
          <nav className="flex items-center gap-2">
            <Link to="/login"><Button variant="ghost" size="sm">Sign in</Button></Link>
            <Link to="/signup"><Button size="sm">Get started</Button></Link>
          </nav>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 opacity-30" style={{ background: "var(--gradient-hero)" }} />
        <div className="container mx-auto px-4 py-24 md:py-32 text-center max-w-4xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur px-3 py-1 text-xs text-muted-foreground mb-6">
            <Sparkles className="size-3" /> Image platform built for digital signage
          </div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight text-foreground">
            Compress, edit, and auto-update <span className="bg-clip-text text-transparent" style={{ backgroundImage: "var(--gradient-primary)" }}>signage images</span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            A full image editor, smart compression server, and a public API your displays pull from. Bind layers to Square menu items and prices update everywhere automatically.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link to="/signup"><Button size="lg" className="shadow-[var(--shadow-elegant)]">Start free <ArrowRight className="ml-1 size-4" /></Button></Link>
            <Link to="/login"><Button size="lg" variant="outline">Sign in</Button></Link>
          </div>
        </div>
      </section>

      <section className="container mx-auto px-4 py-20">
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { icon: ImageIcon, title: "Full image editor", body: "Crop, resize, rotate, flip, filters, text, shapes — everything you need on one canvas." },
            { icon: Zap, title: "Auto-optimize", body: "We pick the best format and quality per image. AVIF, WebP, JPEG — you ship the smallest." },
            { icon: Cloud, title: "Cloud gallery", body: "Every image stored, versioned, slugged. Browse, edit, and reuse across boards." },
            { icon: Code2, title: "Public API", body: "Pull images from your signage app with a single Bearer-token request. CDN-friendly." },
            { icon: ShoppingBag, title: "Square sync", body: "Bind text layers to Square items. Prices change → templates flag stale → re-render in one click." },
            { icon: Sparkles, title: "Signage presets", body: "1080p, 4K, portrait kiosks — start from the right canvas every time." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-card p-6 shadow-[var(--shadow-card)]">
              <div className="size-10 rounded-lg flex items-center justify-center mb-4" style={{ background: "var(--gradient-primary)" }}>
                <f.icon className="size-5 text-primary-foreground" />
              </div>
              <h3 className="font-semibold mb-1">{f.title}</h3>
              <p className="text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        © 2026 Pixelboard
      </footer>
    </div>
  );
}
