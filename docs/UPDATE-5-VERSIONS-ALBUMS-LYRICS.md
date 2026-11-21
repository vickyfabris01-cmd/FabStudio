# Update 5: download switch, audio + video versions, albums, animated screen, lyrics, laptop-only baking

This zip is cumulative (it also holds the files of updates 3 and 4 that these changes build on). Unzip over the project as it is.

## Do these in this order
1. **SQL:** Supabase, SQL Editor, run `supabase/migrations/009_downloads_versions_albums_lyrics.sql` once. (It only adds columns and re-makes the `items_public` view; every existing item keeps working and stays downloadable.)
2. **Worker:** `cd worker && npx wrangler deploy` (the publish route now also copies an item's second version and background picture). `MAX_UPLOAD_MB` is already 500 in `wrangler.toml`.
3. **Site:** commit and push. The Studio cache is `fabstudio-shell-v14`: open the Studio twice. The public site's offline page and install button from update 4 stay as they are.

## What changed (by step)
**1. Allow download.** A switch in the New item form and on every item page, and a default in Settings ("Publishing defaults", per device). Off hides the public Download button; your own Studio download always works. Anyone who knows a file's address can still fetch it: a file people can play cannot be made impossible to save.

**2. Two versions per item.**
- A video you upload gets its audio taken out automatically (no re-encoding, about a second, saved as .m4a next to it). An audio item keeps its video in the same slot once you add or make one.
- Item page, "Video version / Audio version": upload your own, replace, remove, or "Take the audio from the video" for older items. A video version for an audio item can be up to 10 minutes and 500 MB; a warning shows if its length differs from the audio by more than 3 s.
- Limits: every new publish is at most 10 minutes (items published earlier are left alone). Videos 500 MB, audio 100 MB.
- Public Download opens a small choice: Audio or Video. A version that does not exist yet is greyed ("Not available yet"). File names: `Fabris Poet - <Title>.<ext>`.
- Public player: a **Listen | Watch** switch appears only when both exist. It remembers the listener's last choice, never switches by itself, and keeps the position when switched. Lock-screen controls (title, cover, play, pause, seek, previous/next part) come from the browser's Media Session.

**3. Laptop-only baking and phone limits** (the 900px rule is unchanged).
- Baking on a laptop now has the console's sound strip: input, gain, level meter and output (where you hear the tune), remembered between sessions, plus "Scroll the poem for me". The sound card opens when the page opens, so the level shows before you record.
- On a phone the Bake button is gone ("Bake on a laptop" if it is opened another way). The Live tab on a phone can schedule and share the link, but has no Go live and no sound strip. Everything else in the Poems page and the Studio (uploads, publish a draft, edit, delete, search, settings) stays.

**4. Albums and recap in parts.**
- Every part published from a recap belongs to the album of its live (the album title is the live's title), even a single part. Parts are ordered by where they start in the recording, whatever order you publish them in.
- A recap longer than 10 minutes shows **Publish in parts**: it proposes parts cut at your timestamps (a long stretch is cut into equal pieces), each at most 10 minutes, with editable titles. A shorter recap keeps "Publish whole recap". Joined clips are also limited to 10 minutes.
- Public home: one album card that looks like a stack ("Album · 3 parts"). Opening it starts at part 1; the item page lists the parts, plays on to the next, and starts again after the last (a tap may be needed on some phones the first time).
- Recap audio is converted from WebM/Opus to .m4a (AAC) so iPhones can play it, when the browser can encode AAC (Chrome or Edge on Windows or Mac). Otherwise the original WebM is kept.

**5. Animated screen and lyrics** (audio items, item page, "Animated screen").
- One template: background picture (optional), "Fabris Poet" mark and title, sound bars, lyrics. It is drawn by one shared function (`site/shared/scene.js`) in the public player, the Studio preview, the thumbnail and the video, from a few KB of settings: no extra data for listeners.
- Pick any moment with the scrubber and use it as the thumbnail. Choose the lyric animation: slide up, fade, typewriter, word by word.
- **Lyrics editor:** tap the first and last line of a block (or "Select next stanza"), play, press Start (S) where it begins, End (E) or pause where it ends; the lines share that time by length, the next stanza is selected, you carry on. Untimed stretches show no lyric. Nudge ±0.1 s, clear, re-time one line, edit the text. "Show lyrics to listeners" is a per-item switch; when on, listeners always see them.

**6. Make video version** (laptop, Chrome or Edge, audio up to 10 minutes). Draws the screen frame by frame and encodes H.264 + AAC into a normal MP4 in the browser, then uploads it as the item's video version. If lyrics are switched on they are in the video.

## Check in a real browser (nothing here was run in a browser)
Everything was syntax- and import-checked, the MP4 writer and the audio extractor were tested against ffmpeg, and the scene was rendered to pictures. The browser media parts (WebCodecs video and audio encoding, the lyrics editor, Media Session, album autoplay) could not be run where this was built, so please try:
1. Upload a short MP4: its audio version appears on the item page; Download on the public page shows both options.
2. Audio item: Animated screen on, pick a picture, scrub, add lyrics for one stanza, Make video version, play the result, then check the Listen | Watch switch on the public page.
3. Publish a recap in parts; open the album card and let a part end.
4. Bake on the laptop with your soundcard; check the level and output choice.
5. On a phone: no Bake button, Live shows no Go live.

## Good to know
- Making a video or converting recap audio needs AAC encoding in the browser (Chrome or Edge on Windows or Mac). Where it is missing you get a clear message and the original file is kept; there is no mp3 fallback yet.
- The Studio's own Download button saves the main file only; the choice of Audio or Video is on the public page.
- The Settings default for Allow download is per device, not synced.
- Lyrics timing drafts (including untimed lines) stay in the Studio on the device where you made them; the timed lines sync.
