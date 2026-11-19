-- FabStudio update: live recap, viewer log, recap marker, live totals.
-- ACTION: run ONCE in Supabase > SQL Editor, AFTER 006_live_part1.sql. Safe to run again.
-- Run it BEFORE you deploy the new site files (the Studio sends source_live_id when a recap post is made).
--
-- What this adds (and only what was missing, nothing that already exists is copied):
--   * live_log: one row per live with the viewer list (names, join time, messages, Love given) saved by the
--     Worker when the live ends. Chat is NOT copied here: it is already saved in `comments` while the live runs.
--     Love taps per person are NOT copied here either: they are already in `live_love`.
--   * published_items.source_live_id: set on posts made from a live recap, so the public "More from Fabris"
--     list can leave them out. Nullable, so every existing post is untouched.
--   * items_public gets that column at the end (nothing existing changes).
--   * live_totals(): one row per live with its Love total (from live_love) and chat count (from comments),
--     owner only. Used by the live cards, the recap header and the Performance page, because the owner cannot
--     page through thousands of live_love rows from the browser.
--
-- Nothing is deleted. Love on posts (counters.n_love, reactions) stays in the database; the apps just stop showing it.

-- 1. The viewer log. Owner reads it; the Worker (service role) writes it when the live ends.
create table if not exists public.live_log (
  item_id uuid primary key references public.live_sessions(item_id) on delete cascade,
  saved_at timestamptz not null default now(),
  viewers jsonb not null default '[]'::jsonb,   -- named people only: [{ name, uid8, joined_at, messages, love }]
  total_viewers int not null default 0,         -- everyone who joined while live, named or not
  anon_viewers int not null default 0,          -- guests (no name): counted here, never listed
  love_total int not null default 0             -- all Love taps of this live
);

alter table public.live_log enable row level security;
revoke all on public.live_log from anon, authenticated;
grant select on public.live_log to authenticated;
drop policy if exists "owner reads live log" on public.live_log;
create policy "owner reads live log" on public.live_log for select to authenticated
  using (public.is_owner());

-- 2. Posts made from a live recap remember which live they came from.
alter table public.published_items
  add column if not exists source_live_id uuid references public.published_items(id) on delete set null;
create index if not exists published_items_source_live_idx on public.published_items (source_live_id)
  where source_live_id is not null;

-- 3. The public view gets the new column at the end. Everything else stays exactly as it was.
create or replace view public.items_public with (security_invoker = false) as
select i.id, i.kind, i.title, i.description, i.mime, i.duration,
       i.public_media_key, i.public_thumb_key, i.published_at, i.comments_enabled, i.reactions_enabled,
       coalesce(c.n_views, 0) as n_views, coalesce(c.n_love, 0) as n_love, coalesce(c.n_like, 0) as n_like,
       coalesce(c.n_reactions, 0) as n_reactions, coalesce(c.n_comments, 0) as n_comments,
       i.source_live_id
from public.published_items i
left join public.counters c on c.item_id = i.id
where i.status = 'published';

revoke all on public.items_public from anon, authenticated;
grant select on public.items_public to anon, authenticated;

-- 4. Love total and chat count per live, for the owner only (empty for anyone else).
create or replace function public.live_totals()
returns table (item_id uuid, love bigint, chats bigint)
language sql stable security definer set search_path = public
as $$
  select l.item_id,
         coalesce((select sum(x.taps) from public.live_love x where x.item_id = l.item_id), 0)::bigint,
         coalesce((select count(*) from public.comments c where c.item_id = l.item_id and not c.hidden), 0)::bigint
  from public.live_sessions l
  where public.is_owner();
$$;

revoke all on function public.live_totals() from public, anon;
grant execute on function public.live_totals() to authenticated;
