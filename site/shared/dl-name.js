// How downloaded files are named, on the public site and in the Studio:
//     Fabris Poet - <Title>.<ext>
// The title is cleaned so it is a safe file name on every system. A recap title such as
// "Live title · note · 5:30" becomes "Fabris Poet - Live title - note - 5.30.webm".
// Pass a mime type or a stored file key (items/<id>.mp3) and the extension is worked out for you.

const BY_MIME = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'video/mp4': 'mp4', 'video/webm': 'webm',
};

export function extOf({ key = '', mime = '' } = {}) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(key).split('?')[0]);
  if (m) return m[1].toLowerCase();
  return BY_MIME[String(mime).split(';')[0].trim().toLowerCase()] || 'bin';
}

export function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[·•|]\s*/g, ' - ')          // separators used in recap titles
    .replace(/(\d):(\d)/g, '$1.$2')          // 5:30 -> 5.30 (a colon is not allowed in file names)
    .replace(/[\\/:*?"<>]+/g, ' ')            // characters no system accepts
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(\s-)+\s*$/, '')
    .trim()
    .replace(/^[.\s-]+|[.\s]+$/g, '');
}

export function downloadName(title, ext) {
  const base = cleanTitle(title) || 'Untitled';
  const e = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `Fabris Poet - ${base.slice(0, 110).trim()}.${e}`;
}
