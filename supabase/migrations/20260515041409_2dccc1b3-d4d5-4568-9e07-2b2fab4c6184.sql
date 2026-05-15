
-- =========================================================
-- PROFILES
-- =========================================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', NEW.raw_user_meta_data ->> 'full_name', split_part(NEW.email, '@', 1)),
    NEW.raw_user_meta_data ->> 'avatar_url'
  ) ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Generic updated_at trigger fn
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- IMAGES
-- =========================================================
CREATE TABLE public.images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled',
  width INT NOT NULL DEFAULT 0,
  height INT NOT NULL DEFAULT 0,
  original_path TEXT,
  original_size_bytes BIGINT NOT NULL DEFAULT 0,
  optimized_size_bytes BIGINT NOT NULL DEFAULT 0,
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{format, path, size, quality}]
  preset TEXT,                                  -- e.g. "1920x1080", "4k_landscape"
  source TEXT NOT NULL DEFAULT 'upload',        -- 'upload' | 'editor' | 'template'
  template_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);
ALTER TABLE public.images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "images_select_own" ON public.images FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "images_insert_own" ON public.images FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "images_update_own" ON public.images FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "images_delete_own" ON public.images FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER images_touch BEFORE UPDATE ON public.images
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE INDEX images_user_created_idx ON public.images (user_id, created_at DESC);

-- =========================================================
-- TEMPLATES
-- =========================================================
CREATE TABLE public.templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Untitled template',
  preset TEXT NOT NULL DEFAULT '1920x1080',
  width INT NOT NULL DEFAULT 1920,
  height INT NOT NULL DEFAULT 1080,
  canvas_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  square_bindings JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{layerId, square_item_id, field}]
  thumbnail_path TEXT,
  is_stale BOOLEAN NOT NULL DEFAULT false,
  last_price_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "templates_select_own" ON public.templates FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "templates_insert_own" ON public.templates FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "templates_update_own" ON public.templates FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "templates_delete_own" ON public.templates FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER templates_touch BEFORE UPDATE ON public.templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- SQUARE CONNECTIONS
-- =========================================================
CREATE TABLE public.square_connections (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  merchant_id TEXT,
  environment TEXT NOT NULL DEFAULT 'production', -- 'production' | 'sandbox'
  location_id TEXT,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.square_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sq_conn_select_own" ON public.square_connections FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "sq_conn_insert_own" ON public.square_connections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "sq_conn_update_own" ON public.square_connections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "sq_conn_delete_own" ON public.square_connections FOR DELETE USING (auth.uid() = user_id);
CREATE TRIGGER sq_conn_touch BEFORE UPDATE ON public.square_connections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- =========================================================
-- SQUARE ITEMS CACHE
-- =========================================================
CREATE TABLE public.square_items_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  square_item_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  price_cents BIGINT,
  currency TEXT DEFAULT 'USD',
  category TEXT,
  raw JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, square_item_id)
);
ALTER TABLE public.square_items_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sq_items_select_own" ON public.square_items_cache FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "sq_items_insert_own" ON public.square_items_cache FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "sq_items_update_own" ON public.square_items_cache FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "sq_items_delete_own" ON public.square_items_cache FOR DELETE USING (auth.uid() = user_id);

-- =========================================================
-- API KEYS (for public signage API)
-- =========================================================
CREATE TABLE public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'API Key',
  key_prefix TEXT NOT NULL,        -- e.g. "sgn_live_abcd"
  key_hash TEXT NOT NULL,           -- sha256 of full key
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX api_keys_hash_idx ON public.api_keys (key_hash);
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_keys_select_own" ON public.api_keys FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "api_keys_insert_own" ON public.api_keys FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "api_keys_update_own" ON public.api_keys FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "api_keys_delete_own" ON public.api_keys FOR DELETE USING (auth.uid() = user_id);

-- =========================================================
-- TEMPLATE RENDERS
-- =========================================================
CREATE TABLE public.template_renders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES public.templates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  image_id UUID REFERENCES public.images(id) ON DELETE SET NULL,
  price_snapshot JSONB,
  rendered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.template_renders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "renders_select_own" ON public.template_renders FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "renders_insert_own" ON public.template_renders FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "renders_delete_own" ON public.template_renders FOR DELETE USING (auth.uid() = user_id);

-- =========================================================
-- STORAGE BUCKET (private; served via signed URLs or public API)
-- =========================================================
INSERT INTO storage.buckets (id, name, public)
  VALUES ('images', 'images', false)
  ON CONFLICT (id) DO NOTHING;

CREATE POLICY "images_storage_select_own" ON storage.objects FOR SELECT
  USING (bucket_id = 'images' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "images_storage_insert_own" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'images' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "images_storage_update_own" ON storage.objects FOR UPDATE
  USING (bucket_id = 'images' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "images_storage_delete_own" ON storage.objects FOR DELETE
  USING (bucket_id = 'images' AND auth.uid()::text = (storage.foldername(name))[1]);
