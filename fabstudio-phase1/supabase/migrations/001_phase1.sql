-- FabStudio Phase 1 schema.
-- ACTION: run this ONCE in Supabase > SQL Editor (see docs/CONNECTIONS.md, section 1.4).

-- 1. Who is the owner? One row, filled in by you in step 1.5 of CONNECTIONS.md.
create table if not exists public.app_owner (
  singleton boolean primary key default true check (singleton),
  user_id   uuid not null
);
alter table public.app_owner enable row level security;
-- No policies on purpose: API clients cannot read or write this table directly.

-- 2. is_owner(): true only for the one user stored in app_owner.
create or replace function public.is_owner()
returns boolean
language sql stable security definer
set search_path = public
as $$ select exists (select 1 from public.app_owner where user_id = auth.uid()); $$;

revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

-- 3. Server-side change clock used by the app to pull only what changed.
create or replace function public.set_server_updated_at()
returns trigger language plpgsql as $$
begin new.server_updated_at = now(); return new; end $$;

-- 4. Tables. IDs are created on the device (uuid) so work can start offline.
--    No foreign keys on purpose: rows may arrive in any order during sync.
create table if not exists public.poems (
  id uuid primary key,
  title text not null default '',
  stanzas jsonb not null default '[]'::jsonb,
  tune_id uuid,
  tune_volume real not null default 0.3,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.tunes (
  id uuid primary key,
  title text not null default '',
  mime text,
  duration real,
  r2_key text,
  rights_note text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

create table if not exists public.idea_captures (
  id uuid primary key,
  poem_id uuid,
  mime text,
  duration real,
  r2_key text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

-- Baked audio (voice + tune in one file). Added in Phase 1 so Phase 2 can publish from it.
create table if not exists public.bakes (
  id uuid primary key,
  poem_id uuid,
  capture_id uuid,
  tune_id uuid,
  tune_volume real,
  mime text,
  duration real,
  r2_key text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);

-- 5. Security: only the owner can touch these tables.
do $$
declare t text;
begin
  foreach t in array array['poems','tunes','idea_captures','bakes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "owner full access" on public.%I', t);
    execute format('create policy "owner full access" on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
    execute format('drop trigger if exists set_server_updated_at on public.%I', t);
    execute format('create trigger set_server_updated_at before insert or update on public.%I for each row execute function public.set_server_updated_at()', t);
    execute format('create index if not exists %I on public.%I (server_updated_at)', t || '_server_updated_at_idx', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
