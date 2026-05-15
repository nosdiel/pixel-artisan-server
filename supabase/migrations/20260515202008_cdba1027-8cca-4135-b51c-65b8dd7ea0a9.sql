insert into storage.buckets (id, name, public) values ('fonts', 'fonts', false) on conflict (id) do nothing;

create policy "fonts_select_own" on storage.objects for select using (bucket_id = 'fonts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "fonts_insert_own" on storage.objects for insert with check (bucket_id = 'fonts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "fonts_update_own" on storage.objects for update using (bucket_id = 'fonts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "fonts_delete_own" on storage.objects for delete using (bucket_id = 'fonts' and auth.uid()::text = (storage.foldername(name))[1]);