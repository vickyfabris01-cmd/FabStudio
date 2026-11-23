# Update 9: live console that recovers, and a badge that says what listeners get

No SQL. Redeploy the **Worker** (`npx wrangler deploy` from `worker/`), then push the **site**. Do both: the console and the Worker work together.

## What it fixes
| Problem | Now |
|---|---|
| After a drop, listeners hear nothing and the console says "already on air from another window" | When the console reconnects it takes the broadcast back by itself, so the room's old dead connection no longer blocks it. |
| Reconnect freezes on a weak connection, the button does nothing | Every request gives up after 15 s, a whole attempt after 30 s, and a late older attempt is thrown away. |
| V8 input silent, level meter flat while music plays, picking the input does not help | A muted or stuck input is detected. Reconnect (or picking the same input) lets go of the old handle first, wakes the browser's audio engine, reopens the V8, and if it comes back under a new ID it finds it by name. |
| Only way out was ending the live | **Reconnect** button is there the whole time you are on air. It also runs by itself (at most every 20 s) when the input is muted, no packets leave the laptop, or the room still says offline. |
| No idea whether anyone hears you | Header badge, green / amber / red, with the reason (hover it for more). |
| Long music title pushes End live off screen | The row can no longer widen. When it is too narrow it wraps to a second line. A long title slides back and forth like on the live page (with reduced motion it shows "…"). |

## The badge
It combines three things: the room (does it list you as on air), this laptop (are packets leaving, is the input silent or muted), and **listener reports**. Each listener's page sends the room one small message every ~10 s (how the audio arrives: good / fair / poor / stalled, and whether it is flat silent). The room sums them and tells only the console, for example "4 of 5 get no sound", never who. Reports older than 35 s are dropped. Red for listeners needs most listeners affected (at least 3 listening); with 1 or 2 it shows amber, because it may be their own network.

## Files
`site/studio/js/live-audio.js`, `live-engine.js`, `console/header.js`, `console/source.js`, `site/studio/css/studio.css`, `site/shared/sfu.js`, `site/js/live.js`, `worker/src/live-room.js`.

## Notes
- The Love history from the previous update is untouched; these changes sit beside it.
- Some browsers (Safari) do not report incoming sound level, so the "silent" part of listener reports only comes from Chrome and Edge listeners. The stalled/weak part works everywhere.
