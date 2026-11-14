# FabStudio and Fabris Poet, Phase 2

Phase 1 gave you the private, offline-first workspace. Phase 2 adds **publishing** and the **public site**.

## What is new
**In FabStudio (private)**
- A **Publish** tab. Make an item from a baked poem, an audio file, or a video file.
- Thumbnails: upload an image, generate one from the title (with the FabisPot mark), or take a frame from the video.
- Title, description, an optional linked poem (its text is shown on the page), and switches for comments and reactions.
- Drafts work offline and upload when you are online. **Publish**, **Unpublish** and **Delete** need internet.
- Delete removes the files, reactions, comments and counters together.
- Moderation: see counts, hide, show or delete a comment, or block a viewer.
- A **Publish** button on every baked file in the poem editor.

**On Fabris Poet (public)**
- Home page with the latest poems. Poem pages with a player, the poem text, reactions (Love, Like, Emotional, Funny), comments, and a share button.
- Viewers can listen with no account. To react or comment they continue as a **guest**, or sign in with **Google** (automatic popup plus a button) or **email and password**.
- A guest who later signs up keeps their reactions and comments.
- Share links look good in chat apps (`/p/<id>` fills in the title, description and picture).
- A rights and policies page (a template for you to complete).
- Per-item counts for plays, each reaction, total reactions and comments.

## How to install into your existing repository
1. Unzip this over your project folder. It **does not contain** `site/shared/config.js` or `worker/wrangler.toml`, so your values are safe.
2. Follow `docs/CONNECTIONS.md`. Only the steps marked **NEW** are needed: run `002_phase2.sql`, set the sign-in options, create the public bucket, add the `PUBLIC_BUCKET` block to `wrangler.toml`, set the service-key secret, redeploy the Worker, and set up Google.
3. Commit and push. Pages deploys the site and the new `functions` folder.
4. Open FabStudio twice so it picks up the new version.

## Folders
```
site/              what Cloudflare Pages publishes
  index.html         Fabris Poet home
  poem/index.html    poem page
  policies/          rights and policies (edit the [BRACKETED] parts)
  js/ css/           public site code and styles
  studio/            FabStudio (adds publish.js and thumbs.js)
  shared/            config.js (yours), Supabase clients, vendored libraries
functions/p/[id].js  share links with link previews (Pages Function)
worker/              Worker: uploads, publish, public file streaming, guest merge
supabase/migrations/ 001 (Phase 1) and 002 (Phase 2)
docs/CONNECTIONS.md  START HERE for every connection step
```

## Test checklist
1. Run `002_phase2.sql`, deploy the Worker, push to GitHub, open FabStudio twice.
2. Bake a poem. In the poem editor tap **Publish** on the baked file. Check the title and linked poem, then **Save draft**. The pill says Synced.
3. Tap **Publish**. On the item page you get a share link.
4. Open the link in a private window. You see the poem, can play it, and can read the text. The thumbnail shows.
5. Share the link in WhatsApp or similar. The preview shows title and picture (a brand new poem avoids cached previews).
6. In the private window, tap a reaction, then **Continue as guest**. The count goes up. Post a comment.
7. In FabStudio, open the item: you see the reaction and comment counts. Hide the comment, and it disappears from the public page.
8. Back in the private window, sign in with Google (and separately with email). Your earlier reaction and comment are still there.
9. Test a video: upload an MP4 under 5 minutes, publish, play, and seek forward (this tests range requests).
10. **Unpublish**: the link stops working. **Delete**: files, reactions and comments are gone.
11. Turn on airplane mode in FabStudio. Make a draft item offline. Reconnect and watch it upload.

## Design notes and small changes from the plan
- **Public files are streamed by your Worker** (`/public/...`) from the public bucket, instead of `r2.dev` or a custom domain. You need no domain, and private files can never be reached by that route.
- **Share links use a Pages Function** (`/p/<id>`), not the Worker, so it deploys with the site and needs no extra settings. Inside the site, poems open at `/poem/?id=<id>`.
- **Guests are merged by the Worker**, not by linking identities. The email route converts the guest in place (same account). Google and "sign in to an existing account" move the guest's data across. This needs the service key as a Worker secret.
- **The public site has its own sign-in session**, separate from your owner session in FabStudio.
- **Publishing copies the file** from the private bucket to the public one, and unpublishing removes the public copy.
- **Poem text is snapshotted when you publish.** Edit the poem later, then tap **Refresh poem text** (or republish) to update the page.
- **The public view hides private file names**, and drafts and unpublished items are invisible to the public.
- **No public service worker or manifest yet.** The public side is a light website. An installable shell can come later.
- **The Publish tab is the fifth tab** in FabStudio.

## Known limits
- **Play counts are approximate:** one per browser per item every 12 hours, and a determined person could inflate them.
- **No rate limiting on comments yet.** Hide, delete and block are your tools. Unblocking is done in Supabase (`viewer_profiles`, set `blocked` to false).
- **Commenter IDs:** each comment carries the commenter's random user ID. It is not their name or email, but it is visible in the data.
- **Cached copies:** after unpublishing, browsers and Cloudflare may keep a copy for up to an hour.
- **Video is not converted.** Only MP4 (H.264) is accepted, up to 5 minutes or 150 MB. Limits are in one place, `LIMITS` in `site/studio/js/publish.js`. Audio is capped at 100 MB.
- **Large videos:** copying a big video from the private to the public bucket runs through the Worker. Test with a real 100 MB file before relying on it.
- **Worker traffic:** every play of a published file goes through your Worker. The free Cloudflare plan allows roughly 100,000 requests a day, which is plenty for a small audience, but check it if you grow.
- **Deleting an item on one device** removes it from your other devices at their next sync.
- **Live** (Phase 3) is not included.

## What was tested before delivery
The SQL (Phase 1 and 2) run twice in a test Postgres, checking who can read and write what, counters, blocking, closed comments, merge and cascade delete. The Worker against simulated buckets (public streaming with ranges, publish, unpublish, delete, guest merge, access control). The sync engine, the Publish screens (draft, publish, moderate, unpublish, delete), the public home and poem pages, viewer sign-in (guest, email conversion, merge, Google popup setup and nonce, password dialog), and the share-link function, all in a simulated browser.

**Not tested, because it needs real accounts and devices:** actual Google, Supabase email and Cloudflare behavior, thumbnail drawing and video frames, audio and video playback, seeking in large files, real phones, and link previews in chat apps. Please run the checklist above and tell me what you see.
