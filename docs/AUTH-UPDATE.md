# Auth, views and reactions update

What changed on the public site:

- Every visitor who opens a poem silently gets a guest account. Their view, Love, Like and comments all belong to it.
- `/auth/` is the sign in page and `/auth/signup/` is the create account page (password typed twice, Google below the main button). The old pop-up and the "Continue as guest" button are gone.
- "Plays" are now "views", counted once per account per poem. Existing play totals carry over.
- Reactions are Love and Like only, shown as icons with counts. A person can give both. A comment button sits beside them.
- The latest comment shows by default. The comment button opens the full scrollable list and the box to write.
- Signing in or creating an account moves the guest's views, reactions and comments across (the Worker's `/viewer/merge` is unchanged).

## Steps, in this order

1. **Supabase, SQL Editor:** paste and run `supabase/migrations/003_views_reactions.sql`. It is safe to run twice.
2. **Supabase, Authentication, Sign In / Providers:** switch **Allow anonymous sign-ins** ON. This is what was missing, and it is why "Continue as guest" failed.
3. **Supabase, Authentication, Rate Limits:** raise **Anonymous sign-ins** above the default of 30 per hour per IP. Shared mobile networks can hit that quickly now that every first view makes a guest.
4. **Supabase, Authentication, URL Configuration:** under Redirect URLs add `https://YOUR-SITE.pages.dev/**` (use your real address). Email confirmation links send people back to the poem they came from, and this setting must allow it.
5. **Email confirmation:** keep it ON and set up your own SMTP (Authentication, Emails). The default mailer is heavily rate-limited. If you turn confirmation OFF, accounts are created instantly and the guest's activity moves straight away, but anyone can register any email address.
6. **Deploy:** the Worker does not change, so no Worker redeploy. Push the site files to Cloudflare Pages as usual.

## Notes

- A guest is created on poem pages only, not on the home page.
- When someone creates an account and the email needs confirming, their guest activity moves after they tap the link, in the same browser.
- Old Emotional and Funny reactions stay in the database but are no longer shown or counted.
- Turnstile: `getCaptchaToken()` in `site/js/auth-ui.js` is the place to plug it in. Also turn on CAPTCHA protection in Supabase, Authentication, Attack Protection.
- Google sign-in stays hidden until `GOOGLE_CLIENT_ID` is set in `site/shared/config.js`.
