# Live redesign, Part 3 (the recap after a live)

This zip contains Part 2 **and** Part 3, so unzip it on top of the project folder whether or not Part 2 is
already there (it replaces the Part 2 files with the same or newer versions). No migration, no Worker change.
It needs migration 006 from Part 1 (`live_sessions.markers`). The studio cache is bumped to v7.

## What changed
Studio
- `js/console/recap.js` (new): the recap screen that replaces the "After the live" card: waveform with playhead, two
  trim handles and timestamp ticks; the timestamp list (tap a time to jump, rename, tap the tag to switch poem / dead
  moment, play from here, "clip" to fill the clip range from that point to the next one, delete, add at the playhead);
  "Publish a clip" (title, start, end, repeatable); "Published from this recap" (title, length, status, Retry);
  "Publish whole recap" (same as the old Publish replay).
- `js/console/webm-cut.js` (new): cuts a part out of the recording without decoding or re-encoding and without any
  download. It reads the WebM block by block (one block = 20 ms), so cuts are exact to 20 ms and a 90 minute
  recording is only read once (about 90 MB in memory). It was tested against real WebM/Opus files, including
  files with unknown-size clusters like MediaRecorder writes; the output decodes cleanly and has the exact length.
- `js/live-engine.js`: saves a loudness history (twice a second) on this laptop while recording, for the waveform,
  and `setMarkers` for the recap's edits. `js/publish.js`: `createDraftFromClip` turns a cut into an ordinary audio
  item (own title, thumbnail, counters) that goes through the existing publisher.
- `js/console/header.js`: "+ Timestamp" button while on air. `js/live.js`, `css/studio.css`, `sw.js`: wiring, styles, cache list.

Public page
- `js/live.js`, `css/live.css`: after the live the page shows ENDED, "Live recap will be available soon" and
  "Thanks for listening to <title>", then "While you wait" (two random published poems, one plays at a time with a
  progress bar), then views, love, like and More poems. Once the recap is published it changes to "This live has
  ended. The replay is ready." with Watch the replay and the final counts (checked every 20 s, no reload needed).

## Decisions taken (change if you disagree)
- ffmpeg.wasm (the plan) was not used: the in-browser WebM cutter does the same job with no 30 MB download, works
  offline, and was testable here. It only handles WebM (what Chrome and Edge record). A recording in another format
  gets a clear message and can still be published whole.
- The waveform uses the loudness saved during the live. For a recording made before this update it falls back to a
  rough waveform from the size of the encoded audio, which may look flat.
- Clips link to their live through a field kept on this device, so "Published from this recap" lists clips made on this
  laptop. The clips themselves are normal items everywhere.
- A clip is published as audio WebM, like the recording itself. Clips follow the same size limits as other audio items.

## Test with a real recording
1. Do a short live (3 to 5 minutes) with a poem tune, a laptop file, and one "+ Timestamp". End it.
2. Recap opens: the waveform shows, the timestamps are listed. Click the waveform, press play, drag the green handles.
3. Rename a timestamp, switch its tag, delete one, add one at the playhead.
4. Publish a clip: it appears under "Published from this recap", then as a normal item in Publish. Play it there.
5. On the phone, reload the live page while the recap is unpublished (recap-soon screen with two poems), then press
   Publish whole recap and wait up to 20 seconds (it switches to Watch the replay).
6. Before relying on it, try one real 60 to 90 minute live: open the recap and cut a clip from the end of it.
