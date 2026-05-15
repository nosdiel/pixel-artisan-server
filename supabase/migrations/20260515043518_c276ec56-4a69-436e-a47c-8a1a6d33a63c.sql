ALTER TABLE public.square_connections
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'api',
  ADD COLUMN IF NOT EXISTS site_url text,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE public.square_connections
  ADD CONSTRAINT square_connections_source_check
  CHECK (source IN ('api', 'online_site'));

ALTER TABLE public.square_connections
  ADD CONSTRAINT square_connections_source_fields_check
  CHECK (
    (source = 'api' AND access_token IS NOT NULL) OR
    (source = 'online_site' AND site_url IS NOT NULL)
  );