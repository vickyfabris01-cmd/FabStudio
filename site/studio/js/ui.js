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
  if (m.startsWith('video/') && m.includes('mp4')) return 'mp4'; // an MP4 video is not audio
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

/* ---------- Studio reorganisation helpers ---------- */
const NS = 'http://www.w3.org/2000/svg';
const svg = (paths, size = 24) => {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
};
export const micIcon = (size) => svg(['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'], size);
export const uploadIcon = (size) => svg(['M12 16V4', 'M7 9l5-5 5 5', 'M5 20h14'], size);
export const dotsIcon = (size) => svg(['M12 5.5v.01', 'M12 12v.01', 'M12 18.5v.01'], size);
export const stopIcon = (size = 18) => { const s = svg([], size); s.setAttribute('fill', 'currentColor'); const r = document.createElementNS(NS, 'rect'); r.setAttribute('x', 6); r.setAttribute('y', 6); r.setAttribute('width', 12); r.setAttribute('height', 12); r.setAttribute('rx', 2); s.append(r); return s; };

// A modal box over the page. Close it with the returned close(); listen for 'modal-close' on box.
export function openModal(...kids) {
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, kids);
  back.append(box);
  document.body.append(back);
  const close = () => { if (!back.isConnected) return; back.remove(); box.dispatchEvent(new CustomEvent('modal-close')); };
  return { close, box };
}

// A small menu under a button. The button's parent must be position: relative (.menuwrap).
export function popMenu(btn, items) {
  const wrap = btn.parentElement;
  const old = wrap.querySelector('.menu');
  if (old) { old.remove(); return; }
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const away = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
  const close = () => { menu.remove(); document.removeEventListener('click', away, true); };
  const menu = h('div', { class: 'menu', role: 'menu' }, items.map((it) => h('button', {
    class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', type: 'button',
    onclick: (e) => { e.stopPropagation(); close(); it.onclick(); },
  }, it.label)));
  menu.addEventListener('click', (e) => e.stopPropagation());
  wrap.append(menu);
  setTimeout(() => document.addEventListener('click', away, true), 0);
}

// A file shown as a pill. Tap plays it (or runs onOpen). Press and hold shows a Delete button.
export function fileChip({ label, sub, getBlob, onOpen, onDelete }) {
  const icon = h('span', { class: 'chip-ic', 'aria-hidden': 'true' }, onOpen ? '◉' : '▶');
  const main = h('button', { class: 'chip-main', type: 'button' }, icon, h('span', {}, label), sub ? h('span', { class: 'chip-s' }, sub) : null);
  const del = h('button', { class: 'chip-del', type: 'button', hidden: true }, 'Delete');
  const wrap = h('div', { class: 'chip' }, main, del);
  let audio = null; let url = null; let press = null; let longed = false; let armTimer = null;
  const reset = () => {
    if (audio) { audio.pause(); audio = null; }
    if (url) { URL.revokeObjectURL(url); url = null; }
    icon.textContent = onOpen ? '◉' : '▶';
    if (stopActive === reset) stopActive = null;
  };
  const disarm = () => { del.hidden = true; clearTimeout(armTimer); };
  const arm = () => { del.hidden = false; clearTimeout(armTimer); armTimer = setTimeout(disarm, 5000); };
  main.addEventListener('pointerdown', () => { longed = false; press = setTimeout(() => { longed = true; arm(); }, 500); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) main.addEventListener(ev, () => clearTimeout(press));
  main.addEventListener('contextmenu', (e) => e.preventDefault());
  main.onclick = async () => {
    if (longed) { longed = false; return; }
    if (!del.hidden) return disarm();
    if (onOpen) return onOpen();
    if (audio) return reset();
    if (stopActive) stopActive();
    icon.textContent = '…';
    const blob = await getBlob();
    if (!blob) { icon.textContent = '▶'; return toast('Not on this device yet. Connect to the internet to download it.'); }
    url = URL.createObjectURL(blob);
    audio = new Audio(url);
    audio.onended = reset;
    audio.onerror = () => { reset(); toast('This audio could not be played.'); };
    stopActive = reset;
    icon.textContent = '■';
    audio.play().catch(reset);
  };
  del.onclick = () => { disarm(); reset(); onDelete(); };
  return wrap;
}