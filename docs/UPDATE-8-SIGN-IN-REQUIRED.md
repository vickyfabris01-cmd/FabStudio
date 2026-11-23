# Update 8: sign-in required (no guest mode)

Visitors can still see the poems list, the comments and the counts. To **listen, watch, react, comment or join a live** they must sign in. The prompt opens on the same page with **Continue with Google**, plus "Sign in with email" and "Create account". After Google sign-in, what they were doing carries on.

## Steps, in this order
1. **Supabase, SQL Editor:** run `supabase/migrations/011_sign_in_required.sql`. Safe to run twice. It makes the database refuse reactions, comments and views from guest sessions.
2. **Worker:** redeploy with `npx wrangler deploy` from `worker/`. Every live now needs a real account.
3. **Site:** push the site files to Cloudflare Pages as usual.
4. **Supabase, Authentication, Sign In / Providers:** turn **off** "Allow anonymous sign-ins". Do this after steps 1 to 3 so nobody is caught half way.

## What changed
- No automatic guest account any more (`auth-ui.js`). `requireAuth(reason)` shows the sign-in prompt and resolves when they are signed in.
- Poem page: play (audio and video), Like, and comment all ask first. Tapping the comment box asks before they start typing. A view is counted for signed-in accounts only.
- Live page: signed-out visitors see "Sign in to join". The Worker refuses guest sessions on every live. The settings "Viewer mode", "Guests can chat" and "Guests can send requests" are gone from the Studio live settings.
- Footer and policies text no longer mention guests.

## Notes
- Old guests: if one still has a guest session in their browser and signs in, their old views, reactions and comments still move to the account.
- Past live recaps keep their guest counts.
- The audio and video files themselves are public Cloudflare R2 links. The site stops people playing without an account, but someone holding a direct file link can still open it.
