# Update 6: new Fabris Poet logo

Unzip over the project root. Only image files, two service workers and this note change. No HTML, CSS or JS edits were needed because every page already points at these file names.

- In-page mark (header, hero, auth, offline, poem share image, live scenes, Studio login/header/video/thumbnails): the emblem only (mic, FP, pen), square, transparent. The wording "Fabris Poet" already sits next to it on the pages.
- Favicon, apple-touch and install icons (public site and Studio): the emblem on the dark brand background. Maskable icons keep it inside the safe zone.
- `fabris-poet-logo.png`, `fabris-poet-mark-full.png`: full logo with the wording (not used by the code).
- `fabris-poet-share.png`: full logo on the dark background, 1200x630 (poem share fallback).
- `sw.js` cache `fabris-public-v1` -> `v2`, `studio/sw.js` cache `fabstudio-shell-v14` -> `v15`, so old logos are dropped.
- Untouched: `fabris-poet-wave.png` (footer sound-wave strip).

After deploying, favicons are cached hard by browsers; a hard refresh or reopening the tab shows the new one. An already installed home-screen icon only changes after reinstalling the app.
