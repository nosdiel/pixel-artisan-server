## What we're building

A full-suite image platform for digital signage:
1. **Browser-based image editor** — crop/resize/rotate/flip, filters, text & annotations, signage size presets
2. **Auto-optimizing compression** — picks best format (AVIF/WebP/JPEG) + quality per image
3. **Cloud gallery** — store originals + compressed variants per user
4. **Public API** — your signage webapp pulls images by ID/slug
5. **Square integration** — design price-driven templates, auto-regenerate when Square prices change
6. **Multi-user auth** — email/password + Google

## Architecture

```text
┌─────────────────┐    ┌──────────────────┐    ┌────────────────┐
│  Editor UI      │───▶│  TanStack server │───▶│ Lovable Cloud  │
│  (Canvas/Fabric)│    │  functions       │    │ (DB + Storage) │
└─────────────────┘    └──────────────────┘    └────────────────┘
                              │                        ▲
                              ▼                        │
                       ┌──────────────┐         ┌──────────────┐
                       │ Square API   │         │ /api/public/ │
                       │ (catalog)    │         │ images/:slug │
                       └──────────────┘         └──────────────┘
```

## Tech choices

- **Editor**: HTML Canvas with `fabric.js` (mature, supports text/shapes/filters/transforms)
- **Compression**: client-side via `browser-image-compression` for first-pass; server-side `sharp`-equivalent via WASM (`@jsquash/avif`, `@jsquash/webp`, `@jsquash/jpeg`) since the Worker runtime can't run native sharp
- **Auto-optimize**: encode to AVIF + WebP + JPEG, pick smallest under a quality threshold
- **Auth**: Lovable Cloud (email/password + Google)
- **Storage**: Lovable Cloud Storage bucket `images` (public read for served URLs, RLS write per user)
- **DB tables**:
  - `profiles` (user info)
  - `images` (id, user_id, slug, title, original_path, variants jsonb, width, height, created_at)
  - `templates` (id, user_id, name, canvas_json, square_bindings jsonb, signage_preset)
  - `square_connections` (user_id, access_token encrypted, merchant_id, last_sync_at)
  - `template_renders` (template_id, rendered_image_id, last_rendered_at, price_snapshot jsonb)
- **Square**: per-user OAuth (since each user connects their own Square account). Square is not a Lovable connector — user pastes a Square access token (Personal Access Token from Square Dashboard) for v1 to keep scope sane. We'll build full OAuth later if needed.
- **Auto-regenerate**: cron-style endpoint `/api/public/cron/sync-square` polls each user's Square catalog hourly, diffs prices, re-renders bound templates server-side via headless canvas (`@napi-rs/canvas` won't run on Worker → use `skia-canvas` WASM or render via the same fabric.js JSON in a server-side renderer like `node-canvas-webgl`). **Reality check**: server-side fabric rendering on Cloudflare Workers is fragile. Practical v1: render in browser when user opens template, OR via a scheduled client-side worker. I'll implement: when Square price changes detected, mark template "stale" + send notification; user clicks "regenerate" in UI which re-renders client-side and uploads.

## Pages

- `/` — landing (marketing) → CTA to sign up
- `/login`, `/signup`, `/reset-password`
- `/_authenticated/dashboard` — gallery of all images with filters
- `/_authenticated/editor/:id?` — full editor (new image or edit existing)
- `/_authenticated/templates` — list of Square-bound templates
- `/_authenticated/templates/:id` — template editor with Square item picker
- `/_authenticated/settings` — Square token, account, API key for signage
- `/api/public/images/:slug` — serve compressed image (auto-negotiates format via Accept header)
- `/api/public/api/v1/images` — list images (Bearer API key auth)
- `/api/public/cron/sync-square` — triggered hourly to check price changes

## Build order

1. Enable Lovable Cloud, set up auth (email + Google), create DB schema + RLS + storage bucket
2. Landing page + auth pages (login/signup/reset)
3. Dashboard + gallery shell
4. Image editor with fabric.js (crop, resize, rotate, flip, filters, text, shapes, signage presets)
5. Upload + auto-compression pipeline (client-side compression, server stores variants)
6. Public API endpoints + per-user API keys
7. Square integration: token storage, catalog browser, template designer with `{{item.price}}` bindings
8. Stale-template detection + manual regenerate flow
9. Polish, SEO, sitemap

## Design direction

Clean, professional SaaS — think Cloudinary meets Figma. Dark sidebar nav, light editor canvas. Will set up tokens in `src/styles.css`.

## Notes & tradeoffs

- **Square OAuth**: full OAuth flow requires registering an app with Square + storing client secret. v1 uses Personal Access Tokens to ship faster. I can add full OAuth in a follow-up.
- **Server-side rendering of fabric templates**: deferred (see above). Templates regenerate client-side on demand when Square data changes.
- **AVIF encoding**: WASM AVIF encoders are slow. We'll encode AVIF only for images >500KB; smaller ones get WebP only.

This is a multi-day build broken into shippable chunks. I'll start with steps 1–4 in this turn (foundation + editor) and we iterate from there.
