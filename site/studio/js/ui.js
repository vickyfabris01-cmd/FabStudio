// Small UI helpers: element builder, formatting, toast, audio player button.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'selected', 'disabled'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

export const fmtDur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
export const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
export const fmtDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function extFor(mime = '', name = '') {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  const e = (name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return e.length >= 2 && e.length <= 5 ? e : 'bin';
}

let toastTimer;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// Duration of an audio blob. MediaRecorder WebM files report Infinity, hence the seek trick.
export function probeDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) ? v : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (a.duration === Infinity) {
        a.currentTime = 1e101;
        a.ontimeupdate = () => { a.ontimeupdate = null; done(a.duration); };
      } else done(a.duration);
    };
    a.onerror = () => done(0);
    a.src = url;
    setTimeout(() => done(0), 8000);
  });
}

// A play/stop button. `getBlob` is async and may return null (file not on this device yet).
let stopActive = null;
export function playButton(getBlob) {
  const b = h('button', { class: 'btn small', 'aria-label': 'Play' }, '▶');
  let audio = null;
  let url = null;
  const reset = () => {
    if (audio) { audio.pause(); audio = null; }
    if (url) { URL.revokeObjectURL(url); url = null; }
    b.textContent = '▶';
    if (stopActive === reset) stopActive = null;
  };
  b.onclick = async () => {
    if (audio) return reset();
    if (stopActive) stopActive();
    b.textContent = '…';
    const blob = await getBlob();
    if (!blob) { b.textContent = '▶'; return toast('Not on this device yet. Connect to the internet to download it.'); }
    url = URL.createObjectURL(blob);
    audio = new Audio(url);
    audio.onended = reset;
    audio.onerror = () => { reset(); toast('This audio could not be played.'); };
    stopActive = reset;
    b.textContent = '■';
    audio.play().catch(reset);
  };
  return b;
}
