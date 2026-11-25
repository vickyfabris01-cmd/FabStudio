// Reads a YouTube video id out of whatever was pasted: a bare 11-character id, a watch link, a youtu.be link, or a
// /live/, /embed/, /shorts/ link. Plain JavaScript with no browser or Worker APIs, so the Studio, the public page
// and the Worker can all use it.
//   ''    nothing was given (the field is empty)
//   null  something was given but it is not a YouTube video
//   'id'  the 11-character video id
const ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeId(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (ID.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1] || '';
    return ID.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && ID.test(v)) return v;
    const m = u.pathname.match(/^\/(?:live|embed|shorts|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
    if (m) return m[1];
  }
  return null;
}

export const isYouTubeId = (s) => ID.test(String(s || ''));
