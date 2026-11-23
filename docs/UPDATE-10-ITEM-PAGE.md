# Update 10: item page redesign + thumbnail picker fix

Copy the four files into the repo at the same paths, deploy as usual. No database change.

## What changed
- **Item page, laptop (≥900px):** split 2 to 1. Left: title and status, then the **Audio** and **Video** screens side by side at the same size (each shows length and file size), each with its own Download and Edit thumbnail; below them the description, stats with share, and comments. Right: **Publishing** (Allow comments / reactions / download, Publish, Unpublish), **Screen settings**, and a small **Delete this item**.
- **A version not made yet** is greyed out with its call to action in the middle: **Make video version** on the video screen (an audio item), **Take the audio from the video** on the audio screen (a video item), each with "or upload a file". Its Download and Edit thumbnail are greyed too.
- **Where the video is made:** on the video screen itself (progress shows under it). Once made, the ⋯ menu on that screen holds Make again, Replace and Remove.
- **Pen on the audio screen** scrolls to **Screen settings** and highlights it. Screen settings now holds the preview, background picture, lyrics, animation and Turn off. The old "Video version" card and the "Video" section are gone.
- Playing one screen pauses the other. Phones keep one column: audio, video, details, settings, publishing, delete.
- Fixed: the Animation dropdown and the preview seek bar no longer stick out of their card.
- **Thumbnail picker fix:** the old picture stayed on top of the cropper because `.tp-preview { display: block }` beat the `hidden` attribute. Now the picked image shows in the frame and can be dragged and zoomed. The Image tab shows an empty frame until a picture is chosen, and "Use this thumbnail" stays off until the current tab has a result (each tab keeps its own).

## Files
- `site/studio/js/publish.js` (item page, download of the second version)
- `site/studio/js/scene-panel.js` (Screen settings card, new `videoMaker`)
- `site/studio/js/thumb-picker.js`
- `site/studio/css/studio.css`
