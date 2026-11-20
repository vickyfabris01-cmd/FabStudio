# Update 3: hero text, typing jump, Edit button, footer sign-up, live recordings, Google

No SQL, no Worker change. Unzip over the project, commit, push. Open the Studio twice so it picks up the new files.

## What changed
1. **Hero text** (`site/index.html`): "Join Fabris for electrifying Luo poems." and "Listen, react, and watch live performances."
2. **Poem text jumping on phones** (`site/studio/js/app.js`): the box no longer collapses on every key press. Its height is measured on a hidden copy, and a keyboard opening or closing no longer triggers a re-measure.
3. **Edit** (`site/studio/js/publish.js`): an **Edit** item at the top of every Studio card's three-dot menu, and an **Edit** button on the item page. One form changes the title, the description and (with **Change thumbnail**) the thumbnail. The pencils still work.
4. **Footer sign-up** (`site/js/footer-invite.js`, `site/css/public.css`, home, poem and live pages): a "Create a free account" block with its benefits and a **Create account** button. Hidden for signed-in members (guests still see it).
5. **Live recordings are no longer poems** (`site/studio/js/app.js`): a live's recording is never turned into an empty poem. On the next start while online, the empty "Recording <date>" poems already made from live recordings are removed. The recording stays under its live.
6. **Google sign-in**: no code change, see below.

## Google sign-in (your setup, about 15 minutes)
1. console.cloud.google.com: create or pick a project. Set up the consent screen (app name Fabris Poet, External). Publish it to **In production** when ready.
2. Credentials, Create credentials, OAuth client ID, **Web application**. Authorized JavaScript origins: `https://fabstudio.pages.dev`. Leave redirect URIs empty.
3. Copy the Client ID and Client secret.
4. Supabase, Authentication, Providers, **Google**: switch on, paste both. Leave "Skip nonce checks" off.
5. Paste the Client ID into `GOOGLE_CLIENT_ID` in `site/shared/config.js` (this zip does not contain that file), commit and push.
6. Test in a private window: the popup and the "Continue with Google" button should appear on /auth/ and /auth/signup/.

## Check in a real browser
- Phone: type a long poem in the editor, no jumping, also when the keyboard opens and closes.
- Studio card menu, Edit: the form opens on the item page; change the title and description and save.
- Public pages, signed out: the sign-up block shows in the footer; signed in: it does not.
- Studio Poems: the empty "Recording ..." poems from past lives are gone after a start while online.
