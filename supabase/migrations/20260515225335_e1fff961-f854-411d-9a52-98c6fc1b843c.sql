-- Per-user signage settings (renderer URL, auth token, company ID, auto-publish toggle)
CREATE TABLE public.signage_settings (
  user_id UUID NOT NULL PRIMARY KEY,
  company_id TEXT,
  renderer_url TEXT,
  renderer_auth_token TEXT,
  auto_publish_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.signage_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signage_settings_select_own" ON public.signage_settings
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "signage_settings_insert_own" ON public.signage_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "signage_settings_update_own" ON public.signage_settings
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "signage_settings_delete_own" ON public.signage_settings
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER signage_settings_touch_updated_at
  BEFORE UPDATE ON public.signage_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Per-template publish status from the external renderer
ALTER TABLE public.templates
  ADD COLUMN last_published_at TIMESTAMPTZ,
  ADD COLUMN last_published_url TEXT,
  ADD COLUMN last_publish_status TEXT,
  ADD COLUMN last_publish_error TEXT;