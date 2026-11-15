-- FabStudio Phase 3: Live.
-- ACTION: run ONCE in Supabase > SQL Editor, AFTER 004_no_published_text.sql. Safe to run again.
--
-- A live session is a normal published item (kind = 'live'), so views, Like, Love and comments
-- are counted per session exactly like any other item. This table adds what only a live needs.
-- When the session is over and you publish the replay, the same item gets its recording
-- (public_media_key) and keeps its counters.

-- 1. The live session itself. Owner only; the public reads the safe view in section 3.
create table if not exists public.live_sessions (
  item_id uuid primary key references public.published_items(id) on delete cascade,
  state text not null default 'scheduled' check (state in ('scheduled','live','ended')),
  starts_at timestamptz,                         -- planned start. Never starts the live by itself.
  started_at timestamptz,
  ended_at timestamptz,
  settings jsonb not null default '{}'::jsonb,   -- the live settings (see docs/LIVE.md)
  capture_id uuid,                               -- the recording made in FabStudio
  peak_viewers int not null default 0,
  requests jsonb not null default '[]'::jsonb,   -- requests and questions, saved when the live ends
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists live_sessions_state_idx on public.live_sessions (state, starts_at);

create or replace function public.trg_live_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists live_sessions_touch on public.live_sessions;
create trigger live_sessions_touch before update on public.live_sessions
  for each row execute function public.trg_live_touch();

-- 2. Security: only the owner touches the table. The Worker (service role) updates it as the live runs.
alter table public.live_sessions enable row level security;
revoke all on public.live_sessions from anon, authenticated;
grant select, insert, update, delete on public.live_sessions to authenticated;
drop policy if exists "owner full access" on public.live_sessions;
create policy "owner full access" on public.live_sessions for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- 3. What the public may read: published live items only, and only the settings a visitor needs
--    before the live starts. Chat, requests and moderation are handled live by the Worker.
create or replace view public.live_public with (security_invoker = false) as
select l.item_id as id, i.title, i.description, i.public_thumb_key, i.public_media_key, i.duration,
       l.state, l.starts_at, l.started_at, l.ended_at,
       jsonb_build_object(
         'mode',               coalesce(l.settings->>'mode', 'open'),
         'showViewCount',      coalesce((l.settings->>'showViewCount')::boolean, true),
         'countdownEnabled',   coalesce((l.settings->>'countdownEnabled')::boolean, true),
         'countdownMinutes',   coalesce((l.settings->>'countdownMinutes')::int, 60)
       ) as settings,
       coalesce(c.n_views, 0) as n_views, coalesce(c.n_love, 0) as n_love, coalesce(c.n_like, 0) as n_like,
       coalesce(c.n_comments, 0) as n_comments,
       i.comments_enabled, i.reactions_enabled
from public.live_sessions l
join public.published_items i on i.id = l.item_id and i.status = 'published'
left join public.counters c on c.item_id = l.item_id;

revoke all on public.live_public from anon, authenticated;
grant select on public.live_public to anon, authenticated;
