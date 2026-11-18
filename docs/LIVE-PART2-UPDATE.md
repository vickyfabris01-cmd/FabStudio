# Live redesign, Part 2 (studio console + public live page)

Unzip on top of the project folder and deploy the site (Cloudflare Pages). **No database migration and no Worker
change**: Part 1 (migration 006 and the room messages) must already be deployed. The studio service worker cache
is bumped to v6, so the first open after deploying fetches the new files.

## What changed

Studio (`site/studio`)
- `js/live.js`: the console is rebuilt as header, four stat cards, sound strip, reading pane beside chat pane. The
  "New live" step now holds the settings list and saves the chosen settings; the scheduled card shows the viewer
  link from the moment you schedule, and Go live goes straight on air. Existing handlers are kept; only placement moved.
- `js/live-engine.js`: handles `love`, `joined`, `view`, sends `poems` and `show`, and saves markers
  (`addMarker`, into `live_sessions.markers`).
- `js/console/` (new): `header.js`, `stats.js`, `reading.js`, `myaudio.js`, `deck.js`, `chatfeed.js`, `settings-modal.js`.
- `js/app.js`: Settings has an "Audio files folder" panel (Browse folder, Forget).
- `js/ui.js`: three new icons (gear, link, send). `css/studio.css`: console styles. `sw.js`: new files in the cache list.

Public page (`site`)
- `js/live.js`, `css/live.css`: one chat feed, Love beside the message box (hearts rise, "♥ name ×N" lines), Request
  dropdown of poems with more than 5 stanzas plus "Other poem…", running clock in the card, auto-listen with a
  "Tap to listen" fallback, message box above the keyboard. The before-live screen keeps the approved content.

## Decisions taken while building (change if you disagree)
- Pause chat and Mute by ID moved into the gear modal ("Moderation"). Per-message mute and delete stay on each chat line.
  Pin is not shown in the studio.
- The Deck starts a marker in the recording when a poem tune or a laptop file starts (poem = "poem", file = "dead moment").
  Nothing reads markers yet; the recap is Part 3.
- "Playing <name>" shows the tune's title or the file's name. Poem title is sent only if the poem has a title.
- Auto-scroll runs while the poem's own tune plays, and the round arrow in the speed drawer starts or stops it by hand.

## Test (use a phone as the viewer)
1. Studio, Live, New live: pick settings, Schedule live. The viewer link is there; open it on the phone (countdown screen).
2. Settings, Audio files folder, Browse folder. In the console, My audio shows the files; play one with Out set to the V8.
3. Go live. The phone starts listening by itself (or shows "Tap to listen"). Check clock, views, watching +1/-1.
4. Phone: tap the heart (hearts rise, a "♥ name ×N" line appears in the studio feed), send a chat, send a request from the list.
5. Studio: tick Show title and play a poem tune. The phone shows the title and "♪ Playing ...". Untick: they disappear.
6. Open the gear during the live and change a setting: it applies at once. End live: the After the live card appears.
