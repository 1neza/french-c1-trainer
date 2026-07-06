-- Run in Supabase SQL editor
create table if not exists public.usage_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'text',
  created_at timestamptz not null default now()
);

create index if not exists usage_log_user_day on public.usage_log (user_id, created_at);

alter table public.usage_log enable row level security;

-- users may read their own usage (optional)
create policy "read own usage" on public.usage_log
  for select using (auth.uid() = user_id);

-- inserts happen only via edge function (service role bypasses RLS); no insert policy needed
