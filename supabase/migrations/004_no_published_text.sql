-- FabStudio Phase 4: poem text is no longer published. Safe to run again.
-- Run in Supabase > SQL Editor, AFTER 003_views_reactions.sql.
--
-- Poem text stays in Studio. This removes it from the public view and clears the copies
-- that earlier publishes saved on the server.

-- 1. The public view no longer carries poem_title or poem_stanzas.
create or replace view public.items_public with (security_invoker = false) as
select i.id, i.kind, i.title, i.description, i.mime, i.duration,
       i.public_media_key, i.public_thumb_key, i.published_at, i.comments_enabled, i.reactions_enabled,
       coalesce(c.n_views, 0) as n_views, coalesce(c.n_love, 0) as n_love, coalesce(c.n_like, 0) as n_like,
       coalesce(c.n_reactions, 0) as n_reactions, coalesce(c.n_comments, 0) as n_comments
from public.published_items i
left join public.counters c on c.item_id = i.id
where i.status = 'published';

revoke all on public.items_public from anon, authenticated;
grant select on public.items_public to anon, authenticated;

-- 2. Clear the old server copies of poem text.
update public.published_items
   set poem_title = '', poem_stanzas = '[]'::jsonb
 where poem_title <> '' or poem_stanzas <> '[]'::jsonb;
