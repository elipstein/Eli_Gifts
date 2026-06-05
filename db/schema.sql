-- Gift Engine — Supabase (Postgres) schema
--
-- Single table holding every gift idea and its triage status.
-- Run this once in the Supabase SQL editor (or via psql) after creating the project.
--
-- Privacy note: this project uses a SOFT / honor-system privacy model by design.
-- Row Level Security is intentionally left DISABLED so the browser clients (anon key)
-- can read ideas and update status (Keep/Pass) and insert "add my own idea" rows
-- directly. The data is deliberately readable in a browser network tab; the privacy
-- guarantee is "my page never queries kept items," not server-side access control.
-- Do NOT enable RLS here unless you are also adding policies — doing so will break
-- the Keep/Pass buttons and the add-idea form. (See README "Privacy model".)

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
