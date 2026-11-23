# Update 7: profile page

Signed-in people tap their name (top right) to open `/profile/`. There they can change their name, sign out, or delete their account. Guests still see "Sign in".

## Steps, in this order
1. **Supabase, SQL Editor:** paste and run `supabase/migrations/010_profile.sql`. Safe to run twice. Without it, saving a name and deleting an account show "not set up yet".
2. **Worker (optional, live chat only):** `worker/src/live-room.js` has a one-line change so a renamed person's new name also shows in the live chat. Redeploy with `npx wrangler deploy` from `worker/`. Everything else works without this.
3. **Site:** push the site files to Cloudflare Pages as usual.

## Notes
- Name: 1 to 30 characters. Old comments are renamed too. Google sign-in does not overwrite a name you chose.
- Delete account: removes the account, comments, reactions, views and live Love taps. The owner account and guests cannot use it. Past live recaps keep the viewer list they already saved.
- On the live page the name opens the profile in a new tab, so nobody leaves a live by accident.
- Not touched: Studio and the rest of the site.
