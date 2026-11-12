# FabStudio, Phase 1

Your private, offline-first poetry workspace. Part of the FabStudio / Fabris Poet project (FabisPot).

## What Phase 1 does
- **Owner sign-in** (email and password). After the first sign-in the app opens with no internet.
- **Poems:** title and stanzas. Autosaves whenever you pause. No version history, like a phone notepad.
- **Ideas:** one-tap voice recording. Audio is saved every 3 seconds, so nothing is lost if the phone dies. No editing, only delete.
- **Tunes:** upload background music once, reuse it in any poem. Each tune has a rights note.
- **Bake:** voice plus tune mixed into one audio file, in the browser. Preview first.
- **Sync:** text goes to Supabase, audio goes to a private R2 bucket. Everything works offline and syncs when you are back online.
- **Phone friendly:** installable, storage meter, "Protect my data", "Free up space", microphone picker and a raw-audio switch for your soundcard.

Not in Phase 1: publishing, the public site, viewer accounts and live. Those are Phases 2 and 3.

## Folders
```
site/              what Cloudflare Pages publishes
  index.html         placeholder for Fabris Poet (Phase 2)
  studio/            FabStudio (own manifest, service worker, scope /studio/)
  shared/            config.js, Supabase client, vendored libraries
worker/            Cloudflare Worker: owner-only uploads to R2
supabase/migrations/ SQL to run once
docs/CONNECTIONS.md  <- START HERE: every Supabase, Cloudflare, Google and GitHub step
```

## Quick start
1. Follow `docs/CONNECTIONS.md`, sections 1 to 2 (about 30 minutes).
2. Open `https://YOUR-SITE/studio/` and sign in.
3. Run the test below.

## Test checklist (do this before relying on it)
1. Sign in online. Create a poem, record an idea, add a tune, bake. Check the pill says **Synced**.
2. Supabase **Table Editor** shows your rows. Cloudflare **R2** shows files under `captures/`, `tunes/`, `bakes/`.
3. Switch the phone to airplane mode. Fully close and reopen the app. It must open and show your poems.
4. Offline: write a poem, record an idea, bake. The pill says "Offline, N waiting".
5. Turn the connection back on. Within a minute the pill returns to **Synced**.
6. Delete something. It disappears from Supabase and R2 after the next sync.
7. Soundcard test: plug it in, record once so the browser shows device names, then pick it in Settings and tick **Raw audio**.

## Design notes and small changes from the plan
- **Uploads go through the Worker in 8 MB parts** instead of presigned URLs. It needs no extra R2 keys, stays under free-plan request limits, and resumes if the connection drops. Phase 2 can still serve public files straight from a public bucket.
- **Sync uses flags on each row** (`dirty`, `blobPending`) instead of a separate outbox table. It behaves the same: nothing is lost, and work resumes after a crash.
- **Everything the site serves lives in `site/`**, so the Worker code and SQL are never published.
- **`bakes` table added** so Phase 2 can publish baked audio.
- **Baking runs in real time** (a 3-minute poem takes 3 minutes). Keep the screen on. The output is WebM/Opus on Chrome for Android and MP4/AAC where that is what the browser supports.
- **Conflicts:** last write wins, by edit time. Writing the same poem on two offline devices can overwrite one of them. You mostly use one phone, so this is low risk.
- **Libraries are self-hosted** (see `site/shared/vendor/VERSIONS.md`) so the app starts offline.
- **No lock on the phone itself.** Anyone who can unlock your phone can open FabStudio. Use your phone's own screen lock.

## Known limits
- The free Supabase project pauses after a week of inactivity.
- Deleting keeps a small empty record in Supabase so the deletion can sync to your other devices. The text and audio are removed.
- **What was tested before delivery:** every file's syntax; the Worker against a simulated bucket (owner-only access, key checks, multipart); the SQL run twice in a test Postgres, confirming only the owner can read or write; the sync engine (push, pull, conflicts, delete, resumable upload) and crash recovery against a fake database; and the main screens (poem autosave, tunes, ideas, settings, delete) in a simulated browser.
- **Not tested, because it needs a real phone and real accounts:** microphone recording, baking and preview audio, installing the app and the service worker offline, the soundcard, and your actual Supabase and Cloudflare accounts. Please run the checklist above and report anything odd.
