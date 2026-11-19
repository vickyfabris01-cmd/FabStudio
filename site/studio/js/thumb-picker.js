// Choosing a thumbnail, wherever something is published: a new item, a saved item, a recap clip, a baked poem.
// Every thumbnail is a 16:9 card. Three ways to make one:
//   - Title card: the title on a dark card. "Redraw" gives it a new look each time.
//   - Image: your own picture. Drag to move it, use the slider to zoom. It is cropped to 16:9.
//   - Video frame: pick any moment of the video (only when the item is a video).
import { h, openModal, toast, fmtDur } from './ui.js';
import { thumbFromTitle, thumbFromBitmap, thumbFromVideo, drawCover, TITLE_LOOKS } from './thumbs.js';

const chooseImage = () => new Promise((resolve) => {
  const input = h('input', { type: 'file', accept: 'image/*' });
  input.onchange = () => resolve(input.files?.[0] || null);
  input.oncancel = () => resolve(null);
  input.click();
});

// Opens the picker. Resolves with { blob, kind: 'title' | 'image' | 'video', look } or null if it was cancelled.
// current: the thumbnail now in use (a Blob), shown first. video: the video Blob, if the item is a video.
export function pickThumbnail({ title = 'Untitled', video = null, current = null, look = 0, imageOnly = false, heading = 'Thumbnail' } = {}) {
  return new Promise((resolve) => {
    let mode = 'title';
    let result = null;               // what "Use" would return
    let look_ = look;
    let bmp = null; let zoom = 1; let ox = 0; let oy = 0;
    let busy = 0;

    const img = h('img', { class: 'tp-preview', alt: 'Thumbnail preview' });
    const canvas = h('canvas', { class: 'tp-preview', width: 640, height: 360, hidden: true, 'aria-label': 'Drag to move the picture' });
    const show = (blob) => { const u = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(u); img.src = u; };
    if (current) show(current);

    const useBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Use this thumbnail');
    const setResult = (r) => { result = r; show(r.blob); useBtn.disabled = false; };
    const work = async (fn) => {
      const my = ++busy;
      try { await fn(my); } catch (e) { toast(e.message || String(e)); }
    };

    /* title card */
    const redraw = h('button', { class: 'btn', type: 'button' }, 'Redraw');
    const makeTitle = () => work(async (my) => { const blob = await thumbFromTitle(title || 'Untitled', 'Fabris Poet', look_); if (my === busy) setResult({ blob, kind: 'title', look: look_ }); });
    redraw.onclick = () => { look_ = (look_ + 1) % TITLE_LOOKS.length; makeTitle(); };
    const titlePane = h('div', { class: 'tp-pane' }, redraw, h('span', { class: 'muted small' }, 'Tap Redraw for a new look.'));

    /* your own image */
    const zoomEl = h('input', { type: 'range', min: 1, max: 3, step: 0.01, value: 1, 'aria-label': 'Zoom' });
    const drawImg = () => {
      if (!bmp) return;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#14121a'; ctx.fillRect(0, 0, 640, 360);
      drawCover(ctx, bmp, bmp.width, bmp.height, 640, 360, zoom, ox, oy);
    };
    const commitImg = () => work(async (my) => { const blob = await thumbFromBitmap(bmp, { zoom, ox, oy }); if (my === busy) { result = { blob, kind: 'image', look: look_ }; useBtn.disabled = false; } });
    let dragging = null;
    canvas.addEventListener('pointerdown', (e) => { if (!bmp) return; dragging = { x: e.clientX, y: e.clientY, ox, oy }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      // moving the pointer across the whole preview slides the picture across its spare room
      ox = Math.max(-1, Math.min(1, dragging.ox - ((e.clientX - dragging.x) / r.width) * 2));
      oy = Math.max(-1, Math.min(1, dragging.oy - ((e.clientY - dragging.y) / r.height) * 2));
      drawImg();
    });
    const endDrag = () => { if (dragging) { dragging = null; commitImg(); } };
    canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
    zoomEl.oninput = () => { zoom = Number(zoomEl.value); drawImg(); };
    zoomEl.onchange = () => commitImg();
    const pick = h('button', { class: 'btn', type: 'button' }, 'Choose image');
    pick.onclick = async () => {
      const f = await chooseImage(); if (!f) return;
      try { bmp = await createImageBitmap(f); } catch { return toast('That file is not a picture this browser can read.'); }
      zoom = 1; ox = 0; oy = 0; zoomEl.value = 1;
      img.hidden = true; canvas.hidden = false;
      drawImg(); commitImg();
    };
    const imagePane = h('div', { class: 'tp-pane' }, pick, h('span', { class: 'muted small' }, 'Zoom'), h('div', { class: 'grow' }, zoomEl));

    /* a frame of the video */
    let dur = 0;
    const at = h('input', { type: 'range', min: 0, max: 1, step: 0.1, value: 0, 'aria-label': 'Moment of the video' });
    const atText = h('span', { class: 'small muted tp-at' }, '0:00');
    if (video) {
      const probe = document.createElement('video'); const u = URL.createObjectURL(video);
      probe.preload = 'metadata'; probe.onloadedmetadata = () => { dur = probe.duration || 0; at.max = String(Math.max(0.1, dur)); URL.revokeObjectURL(u); };
      probe.src = u;
    }
    at.oninput = () => { atText.textContent = fmtDur(Number(at.value)); };
    at.onchange = () => work(async (my) => { const blob = await thumbFromVideo(video, Number(at.value)); if (my === busy) setResult({ blob, kind: 'video', look: look_ }); });
    const videoPane = h('div', { class: 'tp-pane' }, h('div', { class: 'grow' }, at), atText);

    /* modes */
    const tabs = imageOnly ? [['image', 'Image', imagePane]] : [['title', 'Title card', titlePane], ['image', 'Image', imagePane], ...(video ? [['video', 'Video frame', videoPane]] : [])];
    const tabBtns = tabs.map(([k, l]) => h('button', { class: 'tab' + (k === mode ? ' on' : ''), type: 'button', onclick: () => setMode(k) }, l));
    const panes = h('div', {});
    function setMode(k) {
      mode = k;
      tabBtns.forEach((b, i) => b.classList.toggle('on', tabs[i][0] === k));
      panes.replaceChildren(tabs.find((t) => t[0] === k)[2]);
      const showCanvas = k === 'image' && !!bmp;
      canvas.hidden = !showCanvas; img.hidden = showCanvas;
      if (k === 'title' && !result && !current) makeTitle();
    }

    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const m = openModal(h('h3', {}, heading), h('div', { class: 'tp-frame' }, img, canvas), h('div', { class: 'row c-tabs' }, tabBtns), panes,
      h('div', { class: 'row tp-foot' }, h('span', { class: 'grow' }), cancel, useBtn));
    let done = false;
    const finish = (r) => { if (done) return; done = true; m.close(); resolve(r); };
    m.box.addEventListener('modal-close', () => { if (!done) { done = true; resolve(null); } });
    cancel.onclick = () => finish(null);
    useBtn.onclick = () => finish(result);
    setMode(imageOnly ? 'image' : 'title');
    if (current) { /* the current picture shows until something is changed */ }
  });
}

// A small thumbnail field for the publish forms: a preview, a Thumbnail button and Reset.
// get() always returns a thumbnail: the one picked, or a title card drawn from the title as it is at that moment.
export function thumbField({ getTitle, video = null }) {
  let chosen = null;
  const img = h('img', { class: 'tp-mini', alt: 'Thumbnail' });
  const btn = h('button', { class: 'btn small', type: 'button' }, 'Thumbnail');
  const reset = h('button', { class: 'lnk', type: 'button', hidden: true }, 'Reset');
  const show = (blob) => { const u = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(u); img.src = u; };
  let drawn = 0;
  const auto = async () => { if (chosen) return; const my = ++drawn; try { const b = await thumbFromTitle(getTitle() || 'Untitled'); if (my === drawn && !chosen) show(b); } catch { /* the preview stays empty */ } };
  btn.onclick = async () => {
    const r = await pickThumbnail({ title: getTitle(), video, current: chosen?.blob, look: chosen?.look || 0 });
    if (r) { chosen = r; show(r.blob); reset.hidden = false; }
  };
  reset.onclick = () => { chosen = null; reset.hidden = true; auto(); };
  auto();
  return {
    el: h('div', { class: 'row tp-field' }, img, btn, reset),
    refresh: auto,
    async get() { return chosen || { blob: await thumbFromTitle(getTitle() || 'Untitled'), kind: 'title', look: 0 }; },
  };
}
