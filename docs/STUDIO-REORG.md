# FabStudio reorganisation

Tabs: **Studio**, **Poems**, **Settings**.

## Poems
- Poem list: three-dot menu on each row (Open, Delete poem). The red mic starts a recording; when you stop, a new poem is created, named `Recording <date>`, with the recording inside it.
- Poem page: three-dot menu holds Record, Upload background music, Manage files, Copy text, Delete poem. The poem's files (tune, voice recordings, baked audio) sit under the title: tap to play, press and hold to get Delete. A baked file opens the preview window when tapped.
- Upload background music asks: Pick existing, or Upload new. A poem has one tune; tunes are shared files, so picking an existing one copies nothing.
- A silent blank area always follows the poem text so the page can scroll even when the poem is short.
- Delete poem also deletes that poem's recordings and baked audio. Studio items already made from them stay.
- Recordings from the old Ideas tab that were not linked to a poem get a poem each on first open, so nothing is lost.

## Studio
- **Bake** opens the baking page: pick a poem, read it, tap Start tune (tune plays once at 50 percent, voice at 100 percent, recording starts at the same moment) or Mic (voice only; start the tune later). Recording stops only on Stop.
- After Stop, the preview window opens. It plays the baked file and has a background volume slider. Saving a new volume re-records the mix from the saved voice and tune (real time, keep the screen open).
- The baked file appears in the list as a draft named after the poem. Uploads (floating button) are saved as drafts too.
- Filters: All, Drafts, Published. Newest edit first. Drafts have a Publish button.
- The mic icon beside Bake is a placeholder for Go live (later phase).

## Settings
Sync, Storage (device, plus a static Cloud (R2) line), Recording, Account with Sign out at the bottom.

## Notes
- No database or Worker changes. New fields (`tuneOffset` on bakes, `bakeId` on items) stay on the device.
- The volume slider needs the original voice and tune on this device. Bakes made on another device show a note instead.
- Re-saving the volume updates the Studio draft made from that bake. Published items are not touched.
- Service worker cache is now `fabstudio-shell-v3`. Open the app twice after deploying.
