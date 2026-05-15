CREATE TABLE public.square_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  cursor text,
  processed_items integer NOT NULL DEFAULT 0,
  stale_templates integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE public.square_sync_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY sync_jobs_select_own ON public.square_sync_jobs
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY sync_jobs_insert_own ON public.square_sync_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY sync_jobs_update_own ON public.square_sync_jobs
  FOR UPDATE USING (auth.uid() = user_id);

CREATE TRIGGER trg_sync_jobs_touch
  BEFORE UPDATE ON public.square_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX idx_sync_jobs_user_started ON public.square_sync_jobs(user_id, started_at DESC);