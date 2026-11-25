# YouTube: video beside the audio live

The audio live is **not changed**. Video goes out from your phone to YouTube (the V8's jack output gives the phone
the same sound), and FabStudio only shows and connects it. Everything here is optional: with no YouTube link set,
nothing on the live page or the Studio changes.

## What you get
1. **Watch video on the live page.** A *Watch video* button beside Share, only while you have switched the video on.
   The YouTube player is not loaded until a viewer taps. Opening it pauses that viewer's FabStudio audio (so nothing
   plays twice); *Back to audio only* brings the audio back. Chat, Love and requests stay as they are.
2. **Check YouTube live** (the ready card, before you go on air). One press = one request to YouTube. Nothing is
   ever checked by itself. If your live is found you see its title and a **Show on public live page** button; nothing
   is public until you press it, and *Hide from viewers* undoes it. The same link can be pasted by hand in the live's
   settings (gear), group *YouTube video*.
3. **YouTube library** (Studio page, *YouTube* button). Lists your uploads; **Publish** puts one on Fabris Poet as a
   post that plays from YouTube. Its views, Like and comments are counted on your site (separate from YouTube's own
   numbers). Remove it from the site with Delete in its menu (the video stays on YouTube).

## Install
1. Unzip over the project folder (see "If your local files are newer" below). It does **not** contain
   `site/shared/config.js` or `worker/wrangler.toml`.
2. Supabase, SQL editor: run `supabase/migrations/012_youtube.sql` (adds `youtube_link`, `published_items.youtube_id`,
   and the column on `items_public`).
3. Google Cloud (one time, about 10 minutes):
   - console.cloud.google.com: create a project, then *APIs and services > Library > YouTube Data API v3 > Enable*.
   - *OAuth consent screen*: app name FabStudio, your email; add the scope `.../auth/youtube.readonly`.
     In *Testing* status a connection lasts only 7 days. Press **Publish app** (production) so it lasts; Google may
     show an "unverified app" warning for your own login. That is expected for a one-person app.
   - *Credentials > Create credentials > OAuth client ID > Web application*. Authorized redirect URI:
     `https://fabstudio-api.domanmando10.workers.dev/youtube/callback` (your Worker address + `/youtube/callback`).
   - Copy the Client ID and Client secret.
4. Worker secrets, then redeploy (see `worker/wrangler.toml.youtube-additions.txt`):
   `npx wrangler secret put YT_CLIENT_ID`, `npx wrangler secret put YT_CLIENT_SECRET`, `npx wrangler deploy`.
   `SUPABASE_SERVICE_KEY` must already be set (live chat uses it).
5. Commit and push. Open FabStudio twice so it picks up the new cache (v17).
6. Studio page > *YouTube* > *Connect YouTube* and allow read-only access.

## On YouTube
- Embedding a **live** on other sites is an advanced channel feature. If the Check button says embedding is off, enable
  it for your channel, and tick *Allow embedding* on the live (YouTube Studio > Settings > Channel > Advanced / the live's
  details). Private videos cannot be shown; Unlisted and Public can.
- Going live from the phone: stream with the V8 jack output as the phone's sound input, and test once with an Unlisted
  live before the real one.

## Test checklist
1. Studio > Live > open a live: the ready card has a *YouTube video* row. Press *Check YouTube live* with nothing live:
   "No live found yet". (Not connected yet? It offers *Connect YouTube*.)
2. Start an Unlisted live from the phone. Press *Check YouTube live*: its title appears. Press *Show on public live page*.
3. Go live. On a phone as a viewer: the *Watch video* button shows, the player is absent until tapped. Tap it: the
   FabStudio audio pauses and the video plays. *Back to audio only*: audio returns.
4. In the gear, switch *Viewers can watch the video* off: the viewer's player closes by itself and the audio returns.
5. Studio page > *YouTube*: pick a public video > *Publish*. It appears in the Studio list ("From YouTube") and on the
   home page. Open it as a signed-out visitor: a picture with a play button; signing in then plays it.
6. Like and comment on it; check the numbers in Studio.

## Good to know
- **Quota:** YouTube gives the app 10,000 units a day. A live check is about 1 unit, a page of videos about 2.
- **Data:** the video uses far more data than the audio (roughly 0.3 to 0.5 GB an hour at 360p). It is opt-in, and the
  button says so. Viewers can lower the quality in YouTube's player menu.
- **Delay:** YouTube runs several seconds behind the FabStudio audio, so chat will seem ahead of the picture.
- **Views:** your site counts a view per signed-in account when the post page opens. YouTube counts its own.
- **Privacy:** an Unlisted live's link is only given to viewers while the video is switched on.
- **Nothing is stored in the browser:** the YouTube token lives in the `youtube_link` table, which only the Worker can read.

## Files
New: `worker/src/youtube.js`, `site/studio/js/youtube.js`, `site/js/youtube-embed.js`, `site/shared/youtube-id.js`,
`supabase/migrations/012_youtube.sql`, this file.
Changed (small additions only; no audio file is touched): `worker/src/index.js`, `site/shared/live-settings.js`,
`site/studio/js/live.js`, `site/studio/js/publish.js`, `site/studio/js/sync.js`, `site/studio/sw.js`,
`site/js/live.js`, `site/js/poem.js`, `site/js/data.js`.

## If your local files are newer than GitHub
This was built on the repository as it is on GitHub. If you changed any of the nine "Changed" files locally since
(for example in the baking page or item page work), unzipping would replace your version. Instead, copy only the new
files and apply the changes with `git apply --3way docs/youtube-changes.patch` (from the project folder), which adds
just the small additions to your current files.
