-- FabStudio update 5: download switch, audio+video versions, albums of recap parts, animated screen and lyrics.
-- ACTION: run ONCE in Supabase > SQL Editor, AFTER 008_home_hero_thumbs.sql. Safe to run again.
--
--   * allow_download      : the "Allow download" switch of an item (default on, so every existing item stays downloadable).
--   * alt_key / public_alt_key / alt_mime : the second version of an item. An audio item keeps its video here,
--                           a video item keeps its audio here (the main file stays in media_key / public_media_key).
--   * scene               : the look of the animated screen of an audio item (template name, background picture).
--   * bg_key / public_bg_key : the background picture of that screen (private copy and public copy).
--   * lyrics / show_lyrics: timed lines [{s, e, t}] and the Studio switch. Lyrics reach the public page only when the switch is on.
--   * album_title / album_pos : a recap part belongs to the album of its live (source_live_id). The title is the live's
--                           title when the part was published, album_pos is the order of the parts (1, 2, 3 ...).
--   * items_public gets all of these at the end. Nothing existing changes.

alter table public.published_items add column if not exists allow_download boolean not null default true;
alter table public.published_items add column if not exists alt_key text;
alter table public.published_items add column if not exists public_alt_key text;
alter table public.published_items add column if not exists alt_mime text;
alter table public.published_items add column if not exists scene jsonb;
alter table public.published_items add column if not exists bg_key text;
alter table public.published_items add column if not exists public_bg_key text;
alter table public.published_items add column if not exists lyrics jsonb;
alter table public.published_items add column if not exists show_lyrics boolean not null default false;
alter table public.published_items add column if not exists album_title text;
alter table public.published_items add column if not exists album_pos integer;

create index if not exists published_items_album_idx on public.published_items (source_live_id, album_pos)
  where source_live_id is not null;

create or replace view public.items_public with (security_invoker = false) as
select i.id, i.kind, i.title, i.description, i.mime, i.duration,
       i.public_media_key, i.public_thumb_key, i.published_at, i.comments_enabled, i.reactions_enabled,
       coalesce(c.n_views, 0) as n_views, coalesce(c.n_love, 0) as n_love, coalesce(c.n_like, 0) as n_like,
       coalesce(c.n_reactions, 0) as n_reactions, coalesce(c.n_comments, 0) as n_comments,
       i.source_live_id, i.thumb_kind,
       i.allow_download, i.public_alt_key, i.alt_mime, i.scene, i.public_bg_key, i.show_lyrics,
       case when i.show_lyrics then i.lyrics end as lyrics,
       i.album_title, i.album_pos
from public.published_items i
left join public.counters c on c.item_id = i.id
where i.status = 'published';

revoke all on public.items_public from anon, authenticated;
grant select on public.items_public to anon, authenticated;
