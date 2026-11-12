# Connections guide: Supabase, Cloudflare, Google, GitHub

Do these in order. Every value you must copy or paste is marked **ACTION**, and the table in
section 5 lists them all in one place. Dashboard labels change now and then, so if a menu name
differs slightly, look for the closest match.

## 0. How the pieces connect

```
 Phone / laptop browser  (FabStudio, served by Cloudflare Pages from the /site folder)
   |
   |-- sign in, poems, tunes, idea rows ------> SUPABASE  (Auth + Postgres, protected by RLS)
   |
   `-- audio files (ideas, tunes, bakes) -----> WORKER (fabstudio-api) ---> R2 bucket (private)
            sends the owner's Supabase token      checks the token with Supabase,
                                                  allows only OWNER_USER_ID
```

- The browser talks to Supabase directly for text and sign-in.
- The browser never talks to R2 directly. Audio goes through the Worker, which refuses everyone except you.
- Google is **not used in Phase 1** (see section 3).

---

## 1. Supabase

### 1.1 Create the project
1. Go to supabase.com, sign in, and choose **New project**.
2. Pick a name and the region closest to your audience, and save the database password somewhere safe.
3. Wait until the project finishes setting up.

Free projects pause after a week of inactivity. If the app suddenly cannot sync, open the
Supabase dashboard and restore the project.

### 1.2 Keep sign-ups closed for now
Authentication, then Sign In / Providers (or Settings): make sure **Email** is enabled, and turn
**off** "Allow new users to sign up" until Phase 2 (viewer accounts). You will create your own user by hand in 1.5.

### 1.3 Copy your project URL and public key
Project Settings, then **API** (or the **Connect** button at the top of the dashboard).

| Value | Looks like | Paste it into |
|---|---|---|
| Project URL | `https://abcd1234.supabase.co` | `site/shared/config.js` as `SUPABASE_URL`, and `worker/wrangler.toml` as `SUPABASE_URL` |
| Anon key (legacy) or Publishable key | long `eyJ...` text, or `sb_publishable_...` | `site/shared/config.js` as `SUPABASE_ANON_KEY`, and `worker/wrangler.toml` as `SUPABASE_ANON_KEY` |

The anon/publishable key is meant to be public. **Never paste the `service_role` or `secret` key into any file in this project.**

### 1.4 Create the tables
1. Open **SQL Editor**, then **New query**.
2. Paste the whole of `supabase/migrations/001_phase1.sql` and press **Run**.
3. Check **Table Editor**: you should see `app_owner`, `poems`, `tunes`, `idea_captures` and `bakes`,
   each marked as having Row Level Security enabled.

### 1.5 Create yourself as the owner
1. **Authentication, then Users, then Add user, then Create new user.** Enter your email and a strong password, and tick **Auto Confirm User**.
2. Copy the new user's **User UID** (a UUID like `3f2b...`).
3. In **SQL Editor** run (with your own UID):
   ```sql
   insert into public.app_owner (user_id) values ('PASTE-YOUR-USER-UID-HERE');
   ```
4. Paste the same UID into `worker/wrangler.toml` as `OWNER_USER_ID`.

Only this user can read or write your poems and upload audio. Anyone else, including future viewers, is refused.

---

## 2. Cloudflare

### 2.1 Account and tools
You need a Cloudflare account and Node.js on your computer. In a terminal:
```
cd worker
npm install
npx wrangler login
```
The last command opens a browser so you can approve access.

### 2.2 Create the private R2 bucket
Dashboard, then **R2 Object Storage**, then **Create bucket**, named `fabstudio-private`.
Or from the terminal: `npx wrangler r2 bucket create fabstudio-private`.

Leave public access **off**. Do not enable the `r2.dev` address or attach a custom domain to this bucket.
(Phase 2 will use a separate public bucket for published poems.)

### 2.3 Fill in the Worker settings
Open `worker/wrangler.toml` and set:

| Setting | Value |
|---|---|
| `bucket_name` | `fabstudio-private` (or your bucket's name). Keep `binding = "PRIVATE_BUCKET"` unchanged |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | from step 1.3 |
| `OWNER_USER_ID` | from step 1.5 |
| `ALLOWED_ORIGINS` | the exact web address(es) FabStudio runs on, comma-separated, no trailing slash. Filled in at step 2.6 |

### 2.4 Deploy the Worker
```
cd worker
npx wrangler deploy
```
It prints the Worker address, like `https://fabstudio-api.YOUR-SUBDOMAIN.workers.dev`.
**Paste it into `site/shared/config.js` as `API_BASE`** (no trailing slash).

Test it: opening `YOUR-WORKER-ADDRESS/health` in a browser should show `{"ok":true}`.

### 2.5 Put the project on GitHub
Create a **private** repository on github.com, then in the project folder:
```
git init
git add .
git commit -m "FabStudio phase 1"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
git push -u origin main
```

### 2.6 Deploy the site with Cloudflare Pages
1. Dashboard, then **Workers & Pages**, then **Create**, then **Pages**, then **Connect to Git**, and choose your repository.
2. **Framework preset:** None. **Build command:** leave empty. **Build output directory:** `site`.
3. Deploy. You get an address like `https://YOUR-PROJECT.pages.dev`.
4. **Add that address to `ALLOWED_ORIGINS`** in `worker/wrangler.toml` (keep `http://localhost:8788` for local testing), then run `npx wrangler deploy` in the `worker` folder again. Without this, the browser blocks uploads with a CORS error.

If the dashboard now steers you to Workers with static assets instead of Pages, use `site` as the assets directory.
FabStudio must be served from the **root** of its address (`https://your-address/studio/`), not from a sub-folder.

### 2.7 Test on your computer first (optional)
In one terminal: `cd worker && npx wrangler dev` (Worker at `http://localhost:8787`).
In another, from the project folder: `npx wrangler pages dev site` (site at `http://localhost:8788`).
While testing locally, set `API_BASE` in `config.js` to `http://localhost:8787`, and switch it back before you deploy.
Microphone access needs HTTPS or `localhost`.

---

## 3. Google (not needed in Phase 1)

FabStudio signs you in with email and password, so **nothing to set up with Google now.**
`GOOGLE_CLIENT_ID` in `site/shared/config.js` is reserved and stays empty.

In Phase 2 (viewer sign-in with the Google popup) you will:
1. Create a project in Google Cloud Console and a **Web application** OAuth client ID (Credentials, then Create credentials, then OAuth client ID).
2. Add your site address as an **Authorized JavaScript origin** and your Supabase callback address
   (`https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`) as an **Authorized redirect URI**.
3. Copy the Client ID and Client secret into Supabase, under Authentication, then Providers, then Google.
4. Put the Client ID in `config.js` as `GOOGLE_CLIENT_ID`.

The Phase 2 README will list the exact fields again at that point.

---

## 4. Install FabStudio on your phone
Open `https://YOUR-SITE/studio/` in Chrome on Android, sign in once with internet, then use the browser menu and choose
**Install app** (or Add to Home screen). In **Settings**, tap **Protect my data** so the browser does not clear your poems to save space.

---

## 5. Every value in one table

| What | Where you get it | Where it goes |
|---|---|---|
| Supabase Project URL | Supabase, Project Settings, API | `site/shared/config.js` (`SUPABASE_URL`), `worker/wrangler.toml` (`SUPABASE_URL`) |
| Supabase anon / publishable key | Same page | `site/shared/config.js` (`SUPABASE_ANON_KEY`), `worker/wrangler.toml` (`SUPABASE_ANON_KEY`) |
| Owner User UID | Supabase, Authentication, Users | SQL insert in 1.5, `worker/wrangler.toml` (`OWNER_USER_ID`) |
| R2 bucket name | Cloudflare, R2 | `worker/wrangler.toml` (`bucket_name`) |
| Worker address | printed by `npx wrangler deploy` | `site/shared/config.js` (`API_BASE`) |
| Pages address | Cloudflare, Workers & Pages | `worker/wrangler.toml` (`ALLOWED_ORIGINS`), then redeploy the Worker |
| Google Client ID | Phase 2 | `site/shared/config.js` (`GOOGLE_CLIENT_ID`) |

---

## 6. If something goes wrong

| What you see | Likely cause and fix |
|---|---|
| Sign-in says "not the FabStudio owner" | Step 1.5 insert was not run, or used the wrong UID |
| Sync pill says "Sync problem", error `api-401` | Your session expired. Open Settings and sign in again |
| Error `api-403` | `OWNER_USER_ID` in `wrangler.toml` does not match your user. Fix it and redeploy the Worker |
| Error `api-400` or `api-413` | A file was rejected: key format, or larger than `MAX_UPLOAD_MB` |
| Browser console shows a CORS error | The exact site address is missing from `ALLOWED_ORIGINS`. Add it and redeploy the Worker |
| Error mentions "permission denied" or "does not exist" | The migration (1.4) was not run, or the owner row (1.5) is missing |
| Nothing syncs for days | The free Supabase project paused. Restore it in the dashboard |
| New version does not appear | The app updates in the background. Close and reopen it twice, or clear site data |
| Microphone will not start | Allow the microphone for the site in browser settings |
