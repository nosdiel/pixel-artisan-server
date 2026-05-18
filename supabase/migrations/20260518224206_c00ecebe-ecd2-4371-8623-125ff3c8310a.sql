ALTER TABLE public.square_connections DROP CONSTRAINT IF EXISTS square_connections_source_fields_check;
ALTER TABLE public.square_connections ADD CONSTRAINT square_connections_source_fields_check CHECK (
  ((source = 'api') AND (access_token IS NOT NULL))
  OR ((source = 'online_site') AND (site_url IS NOT NULL))
  OR ((source = 'toast_api') AND (client_id IS NOT NULL) AND (client_secret IS NOT NULL) AND (restaurant_guid IS NOT NULL))
);