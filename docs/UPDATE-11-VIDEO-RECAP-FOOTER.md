# Update 11: embed-first video, no recap publishing, Follow Fabris footer

Unzip the zip on top of the project folder, then follow "Deploy" at the bottom.
No Worker change. One small database step (migration 013).

## What changed

### Video is embed-first
- **"Make video version" is gone.** An audio item no longer makes a video from its baked audio.
  `scene-render.js` is deleted (and removed from the Studio service worker list). The animated screen
  (Screen settings) is kept: it is the look of the audio player on the public page.
- **The Video slot of an audio item** (item page, right-hand screen) now offers:
  **Pick from YouTube** (your channel's list; videos already on the site or linked to another item are not listed)
  or **upload an MP4 file**. An item has one video: choosing one replaces the other.
  The linked video shows its picture (tap to open it on YouTube), a menu (pick another, replace with an MP4, remove),
  and **Open in YouTube Studio**, which opens that video's page where YouTube offers its own download.
  An uploaded MP4 keeps its normal **Download** button.
- **Open in YouTube Studio** is also in the three-dot menu of any list item that has a YouTube video.
- **Public page:** an item with audio and a YouTube video shows **Listen | Watch**. Listen plays your audio file,
  Watch plays the YouTube video. The listener's choice is remembered on that device. Switching to Watch starts the
  video at the second they were listening at; switching back to Listen starts the audio from the start (YouTube
  does not report its position back). A post that only comes from YouTube works as before.
- Drafts: a baked draft is an ordinary unpublished item. Publishing with only audio, or only video, was and is allowed.
  A published item with changes to publish now shows **Update** (it used to read "Update and republish").
  Linking or removing a YouTube video is saved at once and shows on the public page without pressing Update.
- **Download on the baked take** in the Baking screen (next to Publish), and the Audio screen of the item page already
  has Download: use them to make a video elsewhere.

### Lives: nothing is published afterwards
- **Public live page after the live:** only "This live has ended" and the thank-you. The "More from Fabris" cards
  under it are gone.
- **Recap (Studio):** same screen, same waveform, timestamps, segments, play, join and the saved Chats and Viewers.
  Every **Publish** is now a **Download**:
  - per segment: **Download** (a cut of the recording, saved as .m4a when this browser can encode AAC, otherwise .webm)
  - several ticked segments: **Join & download**
  - the top button: **Download recording** (the whole file, exactly as recorded)
  Removed: titles and thumbnails for publishing, "Publish in parts", the 10-minute limit,
  and the "Published from this recap" list. The recording while live is unchanged.
- **Albums and "Live recap" are removed** from the public home page and from the item page. The Studio no longer
  sends or reads `source_live_id`, `album_title` or `album_pos`.
- Delete the old published recap posts yourself in the Studio (Studio tab, select, delete).

### Footer: Follow Fabris
- New file `site/js/footer-follow.js`, loaded on every public page. The platforms are written in the file
  (YouTube, Facebook, Instagram, TikTok, X, WhatsApp channel) with an empty link each. **You put the links in.**
  A platform with an empty link does not show; with all empty, the section is hidden. Nothing is fetched, the icons are
  in the code, so it appears even on a slow network. Only links starting with https:// are used.
- For YouTube, end the link with `?sub_confirmation=1` so a tap asks the visitor to subscribe.

## Deploy
1. In the Studio, delete the old published recap posts (and any live you do not need).
2. Supabase SQL editor: run `supabase/migrations/013_no_recap_posts.sql` (clears the old album links).
3. Unzip over the project and deploy as usual (Pages for the site). The Worker is not touched.
4. Open `site/js/footer-follow.js`, fill in your links, deploy again.
5. Optional: delete `site/studio/js/scene-render.js` from the project folder (nothing uses it any more).
6. Open the Studio once online so the new service worker (v18) takes over.

## Try it
- Item page of a draft audio item: Video screen, **Pick from YouTube**, choose one, publish. On the public page the
  item shows Listen and Watch.
- A live that ended: Recap, press Download on a segment and open the file.
