-- FabStudio update 2: home page hero pictures, thumbnail kind on posts, recap marker without a link.
-- ACTION: run ONCE in Supabase > SQL Editor, AFTER 007_live_log.sql. Safe to run again.
--
--   * hero_images: up to 7 pictures for the home page hero (slot 1 to 7). Anyone can read; only the owner writes.
--     The files themselves live in the public bucket under hero/ (uploaded by the Worker, route /hero/put).
--   * published_items.thumb_kind: 'title' (a drawn title card), 'image' or 'video' (a picture you chose).
--     The home cards use it: a title card already shows the title, so only your own pictures get the title added.
--   * published_items.source_live_id loses its foreign key, so a post made from a recap still counts as a "Live recap"
--     after that live is deleted (before, deleting the live would have cleared the marker).
--   * items_public gets thumb_kind at the end. Nothing existing changes.

alter table public.published_items add column if not exists thumb_kind text;

do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.published_items'::regclass and contype = 'f'
      and conkey = array[(select attnum from pg_attribute where attrelid = 'public.published_items'::regclass and attname = 'source_live_id')]
  loop
    execute format('alter table public.published_items drop constraint %I', c);
  end loop;
end $$;

create table if not exists public.hero_images (
  slot smallint primary key check (slot between 1 and 7),
  key text not null,
  updated_at timestamptz not null default now()
);
alter table public.hero_images enable row level security;
revoke all on public.hero_images from anon, authenticated;
grant select on public.hero_images to anon, authenticated;
grant insert, update, delete on public.hero_images to authenticated;
drop policy if exists "anyone reads hero" on public.hero_images;
create policy "anyone reads hero" on public.hero_images for select to anon, authenticated using (true);
drop policy if exists "owner writes hero" on public.hero_images;
create policy "owner writes hero" on public.hero_images for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

create or replace view public.items_public with (security_invoker = false) as
select i.id, i.kind, i.title, i.description, i.mime, i.duration,
       i.public_media_key, i.public_thumb_key, i.published_at, i.comments_enabled, i.reactions_enabled,
       coalesce(c.n_views, 0) as n_views, coalesce(c.n_love, 0) as n_love, coalesce(c.n_like, 0) as n_like,
       coalesce(c.n_reactions, 0) as n_reactions, coalesce(c.n_comments, 0) as n_comments,
       i.source_live_id, i.thumb_kind
from public.published_items i
left join public.counters c on c.item_id = i.id
where i.status = 'published';

revoke all on public.items_public from anon, authenticated;
grant select on public.items_public to anon, authenticated;
