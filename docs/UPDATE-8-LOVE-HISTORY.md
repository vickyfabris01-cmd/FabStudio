# Update 8: Love stays in the feed in time order

Before, "♥ Name ×5" lines were built in each browser from live events, so a refresh or a late join showed the chat history but no Love lines. Now the room keeps the last 100 Love lines and sends them with the chat history, and the page sorts both by time.

- `worker/src/live-room.js`: keeps `loveFeed` (merges one person's taps within 2.5 s into one line, same as before) and sends it with `history`.
- `site/js/live.js`: builds the Love lines from the history message.
- No SQL. Redeploy the Worker (`npx wrangler deploy` from `worker/`), then push the site.
- A live that is already running when you deploy starts its Love history from that moment; earlier taps still count in the totals.
