-- 013: nothing is published from a live any more (no recap posts, no albums)
-- Run this once in the Supabase SQL editor, after you have deleted the old published recap posts from the Studio.
-- It only clears the old links. Nothing else changes, and no column is dropped (the public view items_public still
-- lists them, which is harmless).
--
--   * published_items.source_live_id / album_title / album_pos were set on posts made from a live recap, so the
--     public site could group them as an album and leave them out of "More from Fabris". The Studio no longer sends
--     them and the public site no longer reads them, so they are emptied here.

update public.published_items
   set source_live_id = null, album_title = null, album_pos = null
 where source_live_id is not null or album_title is not null or album_pos is not null;
