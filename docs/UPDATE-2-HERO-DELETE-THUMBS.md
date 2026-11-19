# Update 2: home hero and cards, delete, thumbnails, live fixes

Built on the latest `main` (logo commit included). Your logo, favicon and mark changes are kept: the title-card thumbnail still draws your mark, and the new hero uses `fabris-poet-mark.png`.

## Do these in this order
1. **Supabase → SQL Editor:** run `supabase/migrations/008_home_hero_thumbs.sql` (after 007; safe to run twice).
2. **Worker:** `cd worker && npx wrangler deploy` (new `/hero/put` route and the real view total sent to the console).
3. **Site:** deploy. The Studio service worker cache is now `fabstudio-shell-v12`.
4. Open the Studio once while online: it sends `thumb_kind` and the recap marker for existing posts (one time, only after 007/008 exist).
5. Studio → Settings → **Home page pictures**: add up to 7 pictures.

## What changed
1. **Console views stuck at zero.** The public page recorded the view first, so the Worker's own record was "not new" and never told the console. Now the Worker sends the real total from the database on every arrival, a console that opens later gets it on connect, and the console also re-reads it every 15 s.
2. **Delete.** Studio and Live lists: **Select** (tick cards, then **Delete (n)**) and a three-dot menu on every card. Deleting a live removes its public page, chat, Love, viewer log, files and the recording; posts made from its recap stay (their "recap" marker no longer has a foreign key, see 008). A live that is on air cannot be deleted.
3. **Thumbnails** (`thumb-picker.js`): Title card with **Redraw** (6 looks), **Image** (drag to move, zoom, cropped to 16:9) and **Video frame** (any moment). Available when you create an item, on a saved item (**Edit thumbnail**; a published item then shows "update and republish"), and in every recap publish (segment, joined clip, whole recap). All thumbnails are now 16:9.
4. **Public live page.** The poem title and "Playing…" lines in the live card, and the thank-you line after the live, slide back and forth when too long (the header title already did).
5. **Public home.** New invitation hero with a background picture that changes daily (7 slots, Nairobi time, replace-only once all 7 are used) and the live (now or next) as a button; a quiet "Create an account to explore more" line for people without an account; filter **All / Poems / Live recap** plus **All formats / Audio / Video** (shown only when both exist); exact 16:9 cards with a badge saying **Audio** or **Video** and the length, a play glyph on video, a "Live recap" tag, and read-only views, likes and comments. The title is added on a card only when its thumbnail is your own picture (a drawn title card already shows it).
6. **Invite after a played poem.** When a poem or video ends, people without an account get a modal (Create account / Maybe later). Once shown it does not return for 3 days. Guests count as "no account"; what they did as a guest carries over.

## Needs a real browser to check
Dragging and zooming in the thumbnail picker, uploading hero pictures, the sliding lines at narrow widths, and a real live with a second device watching (the console view count).
