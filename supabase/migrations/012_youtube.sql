-- 012: YouTube (live video link, channel connection, and YouTube videos shown as posts)
-- Run this once in the Supabase SQL editor. It only adds things; nothing existing changes.
--
--   * youtube_link: the one saved connection to your YouTube channel (a read-only token). Only the Worker (with the
--     service key) can read or write it. No browser, signed in or not, can reach it.
--   * published_items.youtube_id: a post that plays from YouTube. Its views, reactions and comments are counted
--     here, on your site, exactly like any other post.
--   * items_public gets youtube_id at the end (nothing existing changes).

create table if not exists public.youtube_link (
  id smallint primary key default 1 check (id = 1),     -- one connection only
  refresh_token text not null,
  channel_id text,
  channel_title text,
  uploads_playlist text,
  connected_at timestamptz not null default now()
);
alter table public.youtube_link enable row level security;
revoke all on public.youtube_link from anon, authenticated;   -- no policies on purpose: service role only

alter table public.published_items add column if not exists youtube_id text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'published_items_youtube_id_format') then
    alter table public.published_items
      add constraint published_items_youtube_id_format check (youtube_id is null or youtube_id ~ '^[A-Za-z0-9_-]{11}$');
  end if;
end $$;
create index if not exists published_items_youtube_idx on public.published_items (youtube_id) where youtube_id is not null;

create or replace view public.items_public with (security_invoker = false) as
select i.id, i.kind, i.title, i.description, i.mime, i.duration,
       i.public_media_key, i.public_thumb_key, i.published_at, i.comments_enabled, i.reactions_enabled,
       coalesce(c.n_views, 0) as n_views, coalesce(c.n_love, 0) as n_love, coalesce(c.n_like, 0) as n_like,
       coalesce(c.n_reactions, 0) as n_reactions, coalesce(c.n_comments, 0) as n_comments,
       i.source_live_id, i.thumb_kind,
       i.allow_download, i.public_alt_key, i.alt_mime, i.scene, i.public_bg_key, i.show_lyrics,
       case when i.show_lyrics then i.lyrics end as lyrics,
       i.album_title, i.album_pos,
       i.youtube_id
from public.published_items i
left join public.counters c on c.item_id = i.id
where i.status = 'published';

revoke all on public.items_public from anon, authenticated;
grant select on public.items_public to anon, authenticated;
