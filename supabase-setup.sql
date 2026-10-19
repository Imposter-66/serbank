-- SerBANK 用の保存場所を作ります。Supabase の「SQL Editor」に貼り付けて「Run」を押してください。
create table if not exists public.kv (
  name text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- 外部から直接読み書きされないようにします(サーバーの secret キーだけが使えます)
alter table public.kv enable row level security;
