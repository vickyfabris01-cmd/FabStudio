# Connections guide (Phase 2): Supabase, Cloudflare, Google, GitHub

This guide covers **everything**, so it works for a fresh setup and for upgrading from Phase 1.
If you finished Phase 1, skip the steps marked **(Phase 1, done)** and do the ones marked **NEW**.
Every value you copy or paste is marked **ACTION**, and section 5 lists them all in one table.
Dashboard labels change now and then, so if a menu name differs slightly, look for the closest match.

## 0. How the pieces connect

```
 Visitors ------------> Pages site (/site)  ------ reads published poems ------> SUPABASE
 (Fabris Poet)            |  /p/<id> share links run a small Pages Function        items_public view, comments,
                          |  that adds the title and picture for link previews     reactions, viewer sign-in
                          |
                          `-- audio, video, thumbnails --> WORKER  /public/...  --> R2 PUBLIC bucket

 You (FabStudio) ------> Pages site (/site/studio) -- poems, items, moderation --> SUPABASE (owner only)
                          `-- uploads, publish, unpublish, delete ---> WORKER ---> R2 PRIVATE bucket
                                                                        (publish copies private -> public)
 Guest turns into account --> WORKER /viewer/merge (uses the Supabase service key) --> SUPABASE
```

- Viewers can only read **published** items, through a view that hides private file names.
- Private files (drafts, ideas, tunes, originals) can never be reached from a public address.
- Only you can publish, unpublish, delete, or moderate.

---

## 1. Supabase

### 1.1 Create the project **(Phase 1, done)**
supabase.com, then **New project**. Free projects pause after a week of inactivity, so open the app now and then.

### 1.2 Copy your project URL and public key **(Phase 1, done)**
Project Settings, then **API**. Paste the Project URL and the anon/publishable key into `site/shared/config.js`
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and `worker/wrangler.toml` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`).
**Never** paste the `service_role` or `secret` key into any file.

### 1.3 Run the Phase 1 SQL **(Phase 1, done)**
SQL Editor, then paste `supabase/migrations/001_phase1.sql`, then **Run**.

### 1.4 Create yourself as the owner **(Phase 1, done)**
Authentication, then Users, then Add user (tick **Auto Confirm User**). Copy the User UID, then run
`insert into public.app_owner (user_id) values ('YOUR-UID');` and put the same UID in `wrangler.toml` as `OWNER_USER_ID`.

### 1.5 Run the Phase 2 SQL **(NEW)**
1. SQL Editor, then **New query**.
2. Paste the whole of `supabase/migrations/002_phase2.sql` and press **Run**. It is safe to run twice.
3. Table Editor should now also show `published_items`, `counters`, `viewer_profiles`, `reactions` and `comments`.

Supabase may flag the view `items_public` as a "security definer view". That is intended: it is the only thing the
public can read, and it leaves out private file names and unpublished items.

### 1.6 Turn on viewer sign-in **(NEW)**
Authentication, then **Sign In / Providers** (or Settings):
- Turn **ON** "Allow new users to sign up". Viewers need this. You stay the only owner, because owner power
  comes from your user ID, not from closed sign-ups.
- Turn **ON** "Allow anonymous sign-ins". This is what "Continue as guest" uses.
- Keep the **Email** provider on, with **Confirm email** on.
- Manual linking is **not** needed. (I mentioned it earlier; the site now merges guests differently.)

Authentication, then **URL Configuration**:
- **Site URL:** your Pages address, for example `https://YOUR-PROJECT.pages.dev`.
- **Redirect URLs:** add `https://YOUR-PROJECT.pages.dev/**` and, for local testing, `http://localhost:8788/**`.
  Confirmation and reset-password emails send people back to these addresses.

Authentication, then **Emails / SMTP Settings**: set up your own email sender (SMTP) before real viewers sign up.
Supabase's built-in sender is limited and meant for testing. Any transactional email service works.

### 1.7 Get the service key for guest merging **(NEW)**
Project Settings, then **API**, then copy the `service_role` (or "secret") key.
**This key is a master key. Never put it in a file, in GitHub, or in `config.js`.**
It goes in one place only, as a Worker secret (step 2.4). It is used for one job: moving a guest's reactions and
comments into their real account.

---

## 2. Cloudflare

### 2.1 Tools **(Phase 1, done)**
Node.js, then `cd worker`, `npm install`, `npx wrangler login`.

### 2.2 The two buckets
- **(Phase 1, done)** Private bucket `fabstudio-private`.
- **NEW:** Create a second bucket named `fabstudio-public` (R2 Object Storage, then Create bucket, or
  `npx wrangler r2 bucket create fabstudio-public`). Leave public access **off** and do not enable `r2.dev`.
  Published files are served through your Worker, so you need no domain.

### 2.3 Update `worker/wrangler.toml` **(NEW)**
Your current file stays as it is. **Add** this next to the existing `[[r2_buckets]]` block:
```toml
[[r2_buckets]]
binding = "PUBLIC_BUCKET"
bucket_name = "fabstudio-public"
```
Then update `ALLOWED_ORIGINS` so it contains every address the site runs on, comma-separated, no trailing slashes:
```toml
ALLOWED_ORIGINS = "https://YOUR-PROJECT.pages.dev,http://127.0.0.1:5500,http://localhost:8788"
```
(The same snippet is in `worker/wrangler.toml.phase2-additions.txt`.)

### 2.4 Store the service key as a secret, then deploy **(NEW)**
```
cd worker
npx wrangler secret put SUPABASE_SERVICE_KEY
```
Paste the key from step 1.7 when asked. Then:
```
npx wrangler deploy
```
Open `YOUR-WORKER-ADDRESS/health`. It should show `{"ok":true}`.

### 2.5 Pages **(Phase 1, done, with one check)**
Your Pages project stays as it is: no build command, output directory `site`.
**NEW check:** leave the project's **Root directory** empty (the repository root). The new `functions` folder sits
next to `site`, and Pages only finds it from the root. Every push to GitHub deploys the site and the share-link function together.

The function needs no settings of its own. It reads the Supabase and Worker addresses from `site/shared/config.js`.

### 2.6 Testing on your computer
- `npx wrangler pages dev site` (run from the **project root**, not from `worker`) serves the site at `http://localhost:8788`
  and runs the share-link function.
- VS Code Live Server (root set to `/site` by `.vscode/settings.json`) works for pages, but does **not** run `/p/<id>` links.
  Use `/poem/?id=<id>` there.
- While testing locally, set `API_BASE` in `config.js` to `http://localhost:8787` (run `npx wrangler dev` in `worker`)
  or keep using your deployed Worker, which already allows your local address through `ALLOWED_ORIGINS`.

---

## 3. Google sign-in **(NEW, needed in Phase 2)**

Viewers get the Google popup automatically, with a "Continue with Google" button as the fallback.

1. Go to console.cloud.google.com and create (or pick) a project.
2. Set up the consent screen (it may be called **Google Auth Platform**): app name `Fabris Poet`, your support email.
   Choose **External**. The only information used is name and email, which needs no special review.
   When you are ready for the public, set the publishing status to **In production**. While it is "Testing", only the test users you list can sign in.
   If it asks for an authorized domain and does not accept `pages.dev`, leave it empty or use a domain you own.
3. **Credentials, then Create credentials, then OAuth client ID, then Web application.**
   - **Authorized JavaScript origins:** `https://YOUR-PROJECT.pages.dev`. For local testing also add `http://localhost` and
     `http://localhost:8788` (Google asks for both forms when testing locally).
   - **Authorized redirect URIs:** leave empty (the popup does not use them).
4. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**.
5. Supabase, then Authentication, then **Providers, then Google:** switch it on and paste the Client ID and Client secret.
   Leave "Skip nonce checks" **off**; the site sends a nonce.
6. Paste the Client ID into `site/shared/config.js` as `GOOGLE_CLIENT_ID` and commit.
7. Test in a normal Chrome window where you are signed in to Google, on your deployed address, with no viewer session
   (a private window is fine). The popup should appear by itself.

Good to know:
- If someone closes the popup, Google waits before showing it again. The **Continue with Google** button in the sign-in sheet always works.
- Inside the in-app browsers of some apps (WhatsApp, Facebook, Instagram), Google sign-in can fail.
  The sheet suggests opening the page in the browser, and email or guest access still work.
- The popup needs HTTPS. `localhost` is allowed for testing.

---

## 4. GitHub **(Phase 1, done)**
Commit and push as before. **Do not commit** the service key. `config.js` and `wrangler.toml` hold only public values.

---

## 5. Every value in one table

| What | Where you get it | Where it goes |
|---|---|---|
| Supabase Project URL | Supabase, Project Settings, API | `site/shared/config.js`, `worker/wrangler.toml` |
| Supabase anon / publishable key | Same page | `site/shared/config.js`, `worker/wrangler.toml` |
| **Supabase service key (secret)** | Same page (`service_role`) | **Only** `npx wrangler secret put SUPABASE_SERVICE_KEY` |
| Owner User UID | Supabase, Authentication, Users | SQL insert (1.4), `worker/wrangler.toml` (`OWNER_USER_ID`) |
| Private bucket name | Cloudflare, R2 | `wrangler.toml` (`PRIVATE_BUCKET` block) |
| Public bucket name | Cloudflare, R2 | `wrangler.toml` (`PUBLIC_BUCKET` block) |
| Worker address | printed by `npx wrangler deploy` | `site/shared/config.js` (`API_BASE`) |
| Pages address | Cloudflare, Workers & Pages | `wrangler.toml` (`ALLOWED_ORIGINS`), Supabase URL Configuration, Google origins |
| Google Client ID | Google Cloud Console | `site/shared/config.js` (`GOOGLE_CLIENT_ID`), Supabase Google provider |
| Google Client secret | Google Cloud Console | Supabase Google provider only |

---

## 6. If something goes wrong

| What you see | Likely cause and fix |
|---|---|
| Publishing says "File not uploaded yet" | The upload had not finished. Wait for the pill to say Synced, then tap Publish again |
| Publishing fails with a 500 error | The `PUBLIC_BUCKET` binding is missing in `wrangler.toml`, or the Worker was not redeployed |
| Public page shows poems but no audio or picture | `API_BASE` in `config.js` is wrong, or the Worker was not redeployed with `PUBLIC_BUCKET` |
| Home page says "Could not load poems" | `002_phase2.sql` was not run, or the Supabase URL or key in `config.js` is wrong |
| Reacting says "not available right now" | The item has reactions or comments switched off, you are blocked, or the item is unpublished |
| "Continue as guest" fails | Anonymous sign-ins are off (step 1.6), or the visitor's network hit a sign-up limit. Try again in a while |
| Confirmation or reset email never arrives | Set up SMTP (1.6), check spam, and check Redirect URLs |
| The email link opens a "not allowed" page | The Pages address is missing from Supabase's Redirect URLs |
| Google popup never appears | Not signed in to Google in that browser, popup dismissed earlier, an in-app browser, or the origin is missing from Google's list |
| Google says "origin not allowed" | Add the exact address to Authorized JavaScript origins and wait a few minutes |
| Google works but Supabase refuses | Client ID or secret mismatch in Supabase's Google provider |
| Guest data did not move after sign-in | The service key secret is missing (`npx wrangler secret put SUPABASE_SERVICE_KEY`), or the guest session was already gone |
| Share link shows no preview | Open `YOUR-SITE/p/<id>` and view the page source. If the `og:` tags are missing, the `functions` folder was not deployed (check Root directory, 2.5). Chat apps cache previews, so test with a new poem |
| CORS error in the console | The exact address is missing from `ALLOWED_ORIGINS`. Add it and redeploy the Worker |
| New version does not appear in FabStudio | Close and reopen it twice, or clear the site's cache (not its data) |
