# Update 4: hero cropper, downloads, install button

This zip includes the files of update 3 that these changes build on, so unzip it over the project as it is.

## Do these in this order
1. **Worker:** `cd worker && npx wrangler deploy`. Downloads need it: the Worker now understands `?download=<file name>`. Until it is deployed, the Download button plays the file instead of saving it.
2. **Site:** commit and push. The Studio cache is now `fabstudio-shell-v13`, so open the Studio twice.
3. No SQL.

## What changed
1. **Hero picture cropper** (`thumb-picker.js`, used by Settings, Home page pictures). Drag the picture to move it. Pinch with two fingers to zoom. On a laptop, scroll to zoom, or use the + and - buttons. The zoom slider is gone. Two dashed boxes on the preview show what a laptop (wide and short) and a phone (nearly square) will really show of the picture, so keep the important part inside both. Thumbnails for posts use the same cropper without the boxes.
2. **Download button on every item.**
   - Public item page: a download icon beside Share. It works for guests too.
   - Studio: **Download** in each card's three-dot menu and on the item page. It uses the copy on the device, or fetches it first.
   - Audio and video download as they are (audio keeps its own format; video is MP4).
   - File names: `Fabris Poet - <Title>.<ext>`. Characters that are not allowed in file names are removed, and the separators of recap titles become dashes, for example `Fabris Poet - Live title - note - 5.30.webm`. The naming lives in one place, `site/shared/dl-name.js`.
3. **Install button** in the footer of the home, poem and live pages (`site/js/pwa.js`, `site/js/footer-invite.js`).
   - Android and desktop Chrome or Edge: **Install app** opens the browser's real install prompt.
   - iPhone and iPad: **Install app** shows the Add to Home Screen steps.
   - Hidden when the site is already installed or the browser cannot install it.
   - New files: `site/manifest.webmanifest`, `site/sw.js`, `site/offline.html`, `site/icons/` (made from your logo on the dark background). The service worker only shows a friendly offline page when someone opens the site with no internet. It never stores poems, audio, video or live data, and it leaves `/studio/` alone.

## Check in a real browser
- Settings, Home page pictures: pick a picture, drag, pinch on a phone, scroll on a laptop; the dashed boxes show; Use this thumbnail; the home page hero looks right on phone and laptop.
- Open a published poem: tap the download icon; the file is saved as `Fabris Poet - <Title>.<ext>`. Try one audio and one video.
- Studio: card menu, Download; and Download on the item page.
- Chrome on Android: footer shows Install app; it installs and opens full screen. On an iPhone in Safari: the steps show.
- Turn on airplane mode and open the home page: the "You are offline" page shows.
- The Studio still opens, installs and works offline as before.

## Good to know
- The public app's scope is the whole site (`/`), and the Studio has its own app (`/studio/`). If both are installed on one device they stay separate icons.
- Downloads are for every published item. If you want some items protected (for example ones with a licensed tune), a per-item "Allow download" switch is a small addition.
- Download audio as video, and mp3/m4a conversion, are in the next group.
