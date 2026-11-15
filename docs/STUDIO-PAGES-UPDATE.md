# Studio pages update

## What changed

**Sync only when something waits**
- Changes are pushed a few seconds after you make them. The 60 second timer, coming back to the app and coming back online now only look at the local queue. With nothing waiting they do nothing, so the "Synced" pill stays still.
- Changes made on another device are pulled when the app opens, when you tap **Sync now** in Settings, and after signing in.

**Studio list**
- Each row: title, then "Published · 1 min ago" (or "Draft · edited 3 mins ago"), then icons with numbers: eye (views), love, like, comments.
- Published rows have a three-dot menu: Open, Copy link, Unpublish, Delete. The "Published" badge is gone. Drafts keep the Publish button.

**Item page** (now laid out like the public poem page)
- Title with a pen, picture with play (audio has a seek bar, video plays in place), "Published · 2 hrs ago", description with a pen and "more...", then the read-only numbers and a share icon that copies the link.
- Only the title and description are edited here. Linked poem and Refresh poem text are removed, because poem text is no longer published.
- Actions: Allow comments, Allow reactions, Publish or Update and republish, Unpublish, Delete.
- When you change the title, the thumbnail card is redrawn with the new title. Pictures you picked yourself (an uploaded image, a video frame) stay. Items made before this update ask once whether to redraw the card.
- A redrawn thumbnail on a published item shows **Update and republish**, because the public copy only changes then. Title, description and the two switches go live by themselves.
- Comments (hide, delete, block) appear at the bottom only when an item has comments.

**Fixes**
- The stray word "null" under the item header is gone.
- Long titles and file names no longer run off the thumbnail card. Uploaded file names show underscores as spaces.

## Steps
1. Unzip over the project, replacing files.
2. Commit and deploy to Pages. No SQL and no Worker changes.
3. Open the app twice while online (cache is now `fabstudio-shell-v4`). If the list still says "plays", close the app fully and open it again.
