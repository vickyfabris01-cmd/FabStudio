# Poem page update

What changed:

- The poem page now reads, top to bottom: title (one line, slides slowly when long), the video or the audio thumbnail, "2 hrs ago · 318 views", the description, Love, Like, comment and share, then comments.
- Audio has the play button inside its thumbnail, a seek bar and time, and wave bars that move while it plays. The bars follow the real sound; if the browser cannot read it they fall back to a moving pattern.
- The description is one line with "more...". Tapping it opens the whole text, and "less" closes it. Short descriptions have no "more...".
- Poem text is no longer shown or published. Studio keeps it, and Studio no longer sends it to the server.
- Fixed the word "null" that appeared on the page when a poem had no description.
- Share previews no longer use poem text as a fallback description.

## Steps

1. Supabase, SQL Editor: run `supabase/migrations/004_no_published_text.sql` (after 003). It removes poem text from the public view and clears old server copies.
2. Deploy the site files to Pages. Studio is in the same folder, so it updates too. If Studio is installed on your phone, open it once online so it picks up the new files.
3. Nothing needs republishing. Existing items keep working. Poem text already stored in Studio stays there but is never sent again.

Notes:
- Videos were already published without poem text, so they are unchanged.
- The "Linked poem" choice in Studio still links an item to a poem for your own reference.
