-- Gift Engine — Supabase (Postgres) schema
--
-- Single table holding every gift idea and its triage status.
-- Run this once in the Supabase SQL editor (or via psql) after creating the project.
--
-- Privacy note: this project uses a SOFT / honor-system privacy model by design.
-- The privacy guarantee is "my page never queries kept items," NOT server-side
-- access control — the data is deliberately readable with the public key.
-- Row Level Security is ENABLED at the bottom of this file with permissive
-- policies: the browser clients (publishable key) can still read ideas, update
-- status (Keep/Pass), and insert "add my own idea" rows — but cannot DELETE.
-- That keeps the app working, blocks a public wipe of the table, and clears
-- Supabase's RLS advisor. The weekly generator uses the SECRET key, which
-- bypasses RLS entirely. (See README "Privacy model".)

create table if not exists public.ideas (
  id                 uuid         primary key default gen_random_uuid(),
  created_at         timestamptz  not null default now(),
  title              text         not null,
  description        text,
  category           text,
  est_price          text,
  url                text,
  source             text         not null default 'ai'
                       constraint ideas_source_check check (source in ('ai', 'eli')),
  status             text         not null default 'new'
                       constraint ideas_status_check check (status in ('new', 'kept', 'passed')),
  status_changed_at  timestamptz
);

-- Both pages filter by status (her.html: new + kept; index.html: passed),
-- so a simple index on status keeps those reads cheap as the table grows.
create index if not exists ideas_status_idx on public.ideas (status);

-- Row-Level Security: on, with policies that allow exactly what the two pages do
-- (read / add / update) and nothing else. With no DELETE policy, no one using the
-- public (publishable) key can wipe the table. The secret key used by the weekly
-- generator bypasses RLS, so its inserts are unaffected. Re-runnable: the policies
-- are dropped first so this whole file stays idempotent.
alter table public.ideas enable row level security;

drop policy if exists "ideas public read"   on public.ideas;
drop policy if exists "ideas public insert" on public.ideas;
drop policy if exists "ideas public update" on public.ideas;

create policy "ideas public read"   on public.ideas for select using (true);
create policy "ideas public insert" on public.ideas for insert with check (true);
create policy "ideas public update" on public.ideas for update using (true) with check (true);

-- Keep-alive: free-tier Supabase projects pause after ~7 days of inactivity.
-- A tiny separate table that .github/workflows/keepalive.yml writes to every
-- few days (via the secret key) so the project stays awake. RLS is on with no
-- policies, so the public key can't touch it and Supabase's advisor stays happy;
-- the secret key bypasses RLS.
create table if not exists public.keepalive (
  id         bigint      generated always as identity primary key,
  pinged_at  timestamptz not null default now()
);
alter table public.keepalive enable row level security;
