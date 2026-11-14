-- FabStudio Phase 2: publishing, public reading, reactions, comments.
-- ACTION: run ONCE in Supabase > SQL Editor, AFTER 001_phase1.sql (see docs/CONNECTIONS.md, step 1.6).
-- Safe to run again.

-- 1. Published items (owner-only table; the public reads a safe view, see section 5).
create table if not exists public.published_items (
  id uuid primary key,
  kind text not null default 'audio' check (kind in ('audio','video','live')),
  poem_id uuid,
  title text not null default '',
  description text not null default '',
  poem_title text not null default '',
  poem_stanzas jsonb not null default '[]'::jsonb,
  mime text,
  duration real,
  media_key text,            -- private R2 key (never shown publicly)
  thumb_key text,            -- private R2 key (never shown publicly)
  public_media_key text,     -- key in the public bucket, set when published
  public_thumb_key text,
  status text not null default 'draft' check (status in ('draft','published','unpublished')),
  published_at timestamptz,
  comments_enabled boolean not null default true,
  reactions_enabled boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  server_updated_at timestamptz not null default now()
);

-- 2. Counters, viewer profiles, reactions, comments.
create table if not exists public.counters (
  item_id uuid primary key references public.published_items(id) on delete cascade,
  n_plays int not null default 0,
  n_love int not null default 0,
  n_like int not null default 0,
  n_emotional int not null default 0,
  n_funny int not null default 0,
  n_reactions int not null default 0,
  n_comments int not null default 0
);

create table if not exists public.viewer_profiles (
  user_id uuid primary key,
  nickname text not null default '' check (char_length(nickname) <= 30),
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.reactions (
  item_id uuid not null references public.published_items(id) on delete cascade,
  user_id uuid not null,
  type text not null check (type in ('love','like','emotional','funny')),
  created_at timestamptz not null default now(),
  primary key (item_id, user_id)
);
create index if not exists reactions_user_idx on public.reactions (user_id);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.published_items(id) on delete cascade,
  user_id uuid not null,
  nickname text not null check (char_length(nickname) between 1 and 30),
  body text not null check (char_length(body) between 1 and 500),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists comments_item_idx on public.comments (item_id, created_at desc);
create index if not exists comments_user_idx on public.comments (user_id);

-- 3. Helper functions. They run with owner rights so policies can look at tables viewers cannot read.
create or replace function public.is_blocked() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.viewer_profiles where user_id = auth.uid() and blocked); $$;

create or replace function public.item_published(p uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.published_items where id = p and status = 'published'); $$;

create or replace function public.item_allows_comments(p uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.published_items where id = p and status = 'published' and comments_enabled); $$;

create or replace function public.item_allows_reactions(p uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.published_items where id = p and status = 'published' and reactions_enabled); $$;

-- Counters are recalculated from the real rows, so they can never drift.
create or replace function public.recompute_counters(p uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.counters set
    n_love      = (select count(*) from public.reactions where item_id = p and type = 'love'),
    n_like      = (select count(*) from public.reactions where item_id = p and type = 'like'),
    n_emotional = (select count(*) from public.reactions where item_id = p and type = 'emotional'),
    n_funny     = (select count(*) from public.reactions where item_id = p and type = 'funny'),
    n_reactions = (select count(*) from public.reactions where item_id = p),
    n_comments  = (select count(*) from public.comments where item_id = p and not hidden)
  where item_id = p;
end $$;

create or replace function public.trg_recompute() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.recompute_counters(coalesce(new.item_id, old.item_id));
  return null;
end $$;

create or replace function public.trg_new_item() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.counters (item_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists new_item_counters on public.published_items;
create trigger new_item_counters after insert on public.published_items
  for each row execute function public.trg_new_item();
drop trigger if exists set_server_updated_at on public.published_items;
create trigger set_server_updated_at before insert or update on public.published_items
  for each row execute function public.set_server_updated_at();
drop trigger if exists reactions_recompute on public.reactions;
create trigger reactions_recompute after insert or update or delete on public.reactions
  for each row execute function public.trg_recompute();
drop trigger if exists comments_recompute on public.comments;
create trigger comments_recompute after insert or update or delete on public.comments
  for each row execute function public.trg_recompute();

-- 4. Public functions.
-- Play counts are approximate by design (the site limits repeats per browser).
create or replace function public.record_play(p_item uuid) returns void
language sql security definer set search_path = public
as $$
  update public.counters set n_plays = n_plays + 1
  where item_id = p_item and public.item_published(p_item);
$$;

create or replace function public.set_nickname(p_nick text) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  p_nick := btrim(p_nick);
  if char_length(p_nick) not between 1 and 30 then raise exception 'bad nickname'; end if;
  insert into public.viewer_profiles (user_id, nickname) values (auth.uid(), p_nick)
  on conflict (user_id) do update set nickname = excluded.nickname;
end $$;

-- Moves a guest's reactions and comments to a real account. Only the Worker (service role) may call it.
create or replace function public.merge_users(p_guest uuid, p_account uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_guest is null or p_account is null or p_guest = p_account then raise exception 'bad ids'; end if;
  delete from public.reactions g using public.reactions a
    where g.user_id = p_guest and a.user_id = p_account and a.item_id = g.item_id;
  update public.reactions set user_id = p_account where user_id = p_guest;
  update public.comments set user_id = p_account where user_id = p_guest;
  insert into public.viewer_profiles (user_id, nickname)
    select p_account, nickname from public.viewer_profiles where user_id = p_guest
    on conflict (user_id) do update
      set nickname = case when public.viewer_profiles.nickname = '' then excluded.nickname
                          else public.viewer_profiles.nickname end;
  delete from public.viewer_profiles where user_id = p_guest;
end $$;

-- 5. What the public may read: published items only, without private keys.
create or replace view public.items_public with (security_invoker = false) as
select i.id, i.kind, i.title, i.description, i.poem_title, i.poem_stanzas, i.mime, i.duration,
       i.public_media_key, i.public_thumb_key, i.published_at, i.comments_enabled, i.reactions_enabled,
       coalesce(c.n_plays, 0) as n_plays, coalesce(c.n_love, 0) as n_love, coalesce(c.n_like, 0) as n_like,
       coalesce(c.n_emotional, 0) as n_emotional, coalesce(c.n_funny, 0) as n_funny,
       coalesce(c.n_reactions, 0) as n_reactions, coalesce(c.n_comments, 0) as n_comments
from public.published_items i
left join public.counters c on c.item_id = i.id
where i.status = 'published';

-- 6. Security.
alter table public.published_items enable row level security;
alter table public.counters enable row level security;
alter table public.viewer_profiles enable row level security;
alter table public.reactions enable row level security;
alter table public.comments enable row level security;

revoke all on public.published_items, public.counters, public.viewer_profiles, public.reactions, public.comments from anon, authenticated;
revoke all on public.items_public from anon, authenticated;

grant select, insert, update, delete on public.published_items, public.counters, public.viewer_profiles to authenticated;
grant select, insert, update, delete on public.reactions to authenticated;
grant select, insert, update, delete on public.comments to authenticated;
grant select on public.comments to anon;
grant select on public.items_public to anon, authenticated;

drop policy if exists "owner full access" on public.published_items;
create policy "owner full access" on public.published_items for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

drop policy if exists "owner full access" on public.counters;
create policy "owner full access" on public.counters for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

drop policy if exists "owner full access" on public.viewer_profiles;
create policy "owner full access" on public.viewer_profiles for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
drop policy if exists "read own profile" on public.viewer_profiles;
create policy "read own profile" on public.viewer_profiles for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "owner full access" on public.reactions;
create policy "owner full access" on public.reactions for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
drop policy if exists "read own reactions" on public.reactions;
create policy "read own reactions" on public.reactions for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "add own reaction" on public.reactions;
create policy "add own reaction" on public.reactions for insert to authenticated
  with check (user_id = auth.uid() and not public.is_blocked() and public.item_allows_reactions(item_id));
drop policy if exists "change own reaction" on public.reactions;
create policy "change own reaction" on public.reactions for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and not public.is_blocked() and public.item_allows_reactions(item_id));
drop policy if exists "remove own reaction" on public.reactions;
create policy "remove own reaction" on public.reactions for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "owner full access" on public.comments;
create policy "owner full access" on public.comments for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
drop policy if exists "public reads visible comments" on public.comments;
create policy "public reads visible comments" on public.comments for select to anon, authenticated
  using (not hidden and public.item_published(item_id));
drop policy if exists "add own comment" on public.comments;
create policy "add own comment" on public.comments for insert to authenticated
  with check (user_id = auth.uid() and not public.is_blocked() and public.item_allows_comments(item_id));
drop policy if exists "remove own comment" on public.comments;
create policy "remove own comment" on public.comments for delete to authenticated
  using (user_id = auth.uid());

revoke all on function public.record_play(uuid), public.set_nickname(text), public.merge_users(uuid, uuid),
  public.is_blocked(), public.item_published(uuid), public.item_allows_comments(uuid),
  public.item_allows_reactions(uuid), public.recompute_counters(uuid) from public;
grant execute on function public.record_play(uuid) to anon, authenticated;
grant execute on function public.set_nickname(text) to authenticated;
grant execute on function public.is_blocked(), public.item_published(uuid),
  public.item_allows_comments(uuid), public.item_allows_reactions(uuid) to anon, authenticated;
grant execute on function public.merge_users(uuid, uuid) to service_role;
