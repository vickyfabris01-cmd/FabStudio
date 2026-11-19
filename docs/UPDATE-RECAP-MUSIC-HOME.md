# Update: recap by segments, music loop and folders, no post Love, laptop home, Performance

## Do these in this order
1. **Supabase → SQL Editor:** run `supabase/migrations/007_live_log.sql` (safe to run twice). Run it BEFORE the new site goes live.
2. **Worker:** `cd worker && npx wrangler deploy` (saves the viewer list when a live ends).
3. **Site:** deploy as usual. The service worker cache is now `fabstudio-shell-v11`, so the Studio refreshes on the second open.

Nothing was deleted. Love on posts stays in the database, hidden.

## What changed
- **E. Saved live data.** Chat was already saved in `comments` and Love in `live_love`, so 007 only adds what was missing: `live_log` (named viewers, join time, messages, Love given, guest count), `published_items.source_live_id` (marks posts made from a recap), the same column on `items_public`, and `live_totals()` (Love + chat count per live, owner only). The Worker writes `live_log` in `endSession()`; `joined` now remembers name, join time and message count.
- **D. Post Love removed** from the public post page (`poem.js`, CSS) and from Studio post stats (`publish.js`). Live Love is untouched.
- **B. Recap** (`console/recap.js`, `webm-cut.js`): segments from timestamp to timestamp (first from 0:00), play per segment (one at a time), Publish per segment with title `Live title · note · 5:30`, tick 2+ segments for **Join & publish** (non-adjacent allowed, no re-encode), **Publish whole recap** now makes a NEW post (the old "turn the live into the replay" code is gone). One screen on a laptop; read-only **Chats | Viewers** panel; header with Views, Peak watching, Love. `cutWebm(index, start, end)` still works; `cutWebm(index, [[s,e],…])` joins ranges.
- **C. Public page after a live** (`site/js/live.js`, `data.js`, `live.css`): thank-you note, no counts for viewers, "More from Fabris" with 4 random regular posts in a 2×2 grid (recap posts, live replays and the live itself are left out; a new pick on every visit).
- **A. Music** (`console/playlist.js`, `source.js`, `reading.js`, `myaudio.js`, `deck.js`, Settings): loop all + previous/next inside the folder of the playing track; several saved folders (Add / Remove / per-folder Allow) in the Music dropdown and in Settings. Each file's Deck key is now `folderId:path`, so two folders can hold the same file name. Each auto-advanced track starts fresh and gets its own marker.
- **F. Laptop shell** (`app.js`, `home.js`, `studio.css`): on ≥900px the app opens on Home (Studio, Poems, Live, Settings, Performance) with a strip (total views, posts, lives, most watched live); no sidebar; "‹ Home" button and the brand name go home; Studio / Poems / Live are card grids ~3 across; live cards show views, peak, Love, chats. Phones keep the bottom tabs and lists.
- **G. Performance** (`performance.js`, `stats-data.js`): tabs Overall, Lives, Posts. Only saved numbers are shown; total live time is computed from each live's start and end time.

## Choices made where the plan was silent (change if you disagree)
- Old lives that already have a published replay are NOT in the "More from Fabris" pool.
- Home and Performance are laptop only.
- Lives that ended before this update: chat comes from `comments` (the full saved chat); the Viewers tab lists people who wrote or sent Love, without join times, and says so. Guests are counted, not listed.
- The custom-range clip form was not built (unconfirmed). Posts made from recaps before this update are not marked, so they can appear in "More from Fabris".

## Needs real hardware to check
Real folder permission prompts after a browser restart, loop on the real audio output, a real live ending (viewer list written by the Worker), cuts on a real 90-minute recording, and the laptop layouts at 1366×690.
