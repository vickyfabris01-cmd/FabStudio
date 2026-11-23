// Choosing a thumbnail, wherever something is published: a new item, a saved item, a recap clip, a baked poem.
// Every thumbnail is a 16:9 card. Three ways to make one:
//   - Title card: the title on a dark card. "Redraw" gives it a new look each time.
//   - Image: your own picture. Drag to move it; pinch (or scroll, or the + and - buttons) to zoom. Cropped to 16:9.
//     With guides on (the home page hero), dashed boxes show what laptops and phones will really see of the picture.
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
export function pickThumbnail({ title = 'Untitled', video = null, current = null, look = 0, imageOnly = false, heading = 'Thumbnail', guides = false } = {}) {
  return new Promise((resolve) => {
    let mode = 'title';
    const results = { title: null, image: null, video: null };   // what "Use" returns, per way of making the thumbnail
    let look_ = look;
    let bmp = null; let zoom = 1; let ox = 0; let oy = 0;
    let busy = 0;

    const img = h('img', { class: 'tp-preview', alt: 'Thumbnail preview' });
    const canvas = h('canvas', { class: 'tp-preview', width: 640, height: 360, hidden: true, 'aria-label': 'Drag to move the picture, pinch to zoom' });
    // Dashed boxes for the hero: the card shows the picture cropped to its own shape (about 3.6:1 on a laptop, 1.2:1 on a phone).
    const empty = h('div', { class: 'tp-empty', hidden: true }, 'Choose an image and it shows here. Then drag it to place it.');
    const guideBox = h('div', { class: 'tp-guides', hidden: true, 'aria-hidden': 'true' },
      h('div', { class: 'tp-g tp-g-laptop' }, h('span', {}, 'Laptop')),
      h('div', { class: 'tp-g tp-g-phone' }, h('span', {}, 'Phone')));
    const show = (blob) => { const u = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(u); img.src = u; };
    if (current) show(current);

    const useBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Use this thumbnail');
    const setResult = (r) => { results[r.kind] = r; if (r.kind === mode) { show(r.blob); useBtn.disabled = false; } };
    const work = async (fn) => {
      const my = ++busy;
      try { await fn(my); } catch (e) { toast(e.message || String(e)); }
    };

    /* title card */
    const redraw = h('button', { class: 'btn', type: 'button' }, 'Redraw');
    const makeTitle = () => work(async (my) => { const blob = await thumbFromTitle(title || 'Untitled', 'Fabris Poet', look_); if (my === busy) setResult({ blob, kind: 'title', look: look_ }); });
    redraw.onclick = () => { look_ = (look_ + 1) % TITLE_LOOKS.length; makeTitle(); };
    const titlePane = h('div', { class: 'tp-pane' }, redraw, h('span', { class: 'muted small' }, 'Tap Redraw for a new look.'));

    /* your own image: drag to move, pinch / scroll / + - to zoom */
    const CW = 640; const CH = 360; const MAX_ZOOM = 4;
    const clampZ = (z) => Math.max(1, Math.min(MAX_ZOOM, z));
    const hint = h('span', { class: 'muted small grow' }, 'Drag to move. Pinch or scroll to zoom.');
    const zoomOut = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Zoom out' }, '−');
    const zoomIn = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Zoom in' }, '+');
    const drawImg = () => {
      if (!bmp) return;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#14121a'; ctx.fillRect(0, 0, CW, CH);
      drawCover(ctx, bmp, bmp.width, bmp.height, CW, CH, zoom, ox, oy);
    };
    const commitImg = () => work(async (my) => { const blob = await thumbFromBitmap(bmp, { zoom, ox, oy }); if (my === busy) { results.image = { blob, kind: 'image', look: look_ }; if (mode === 'image') useBtn.disabled = false; } });
    // The picture sits at an offset (in canvas pixels, from the centre); ox and oy are that offset as a share of the spare room.
    const geom = (z) => {
      const base = Math.max(CW / bmp.width, CH / bmp.height) * Math.max(1, z);
      return { sx: Math.max(0, (bmp.width * base - CW) / 2), sy: Math.max(0, (bmp.height * base - CH) / 2) };
    };
    const px = () => { const g = geom(zoom); return { x: ox * g.sx, y: oy * g.sy }; };
    const place = (z, x, y) => {            // sets zoom and offset (in pixels), keeping the picture covering the frame
      zoom = clampZ(z);
      const g = geom(zoom);
      ox = g.sx ? Math.max(-1, Math.min(1, x / g.sx)) : 0;
      oy = g.sy ? Math.max(-1, Math.min(1, y / g.sy)) : 0;
      drawImg();
    };
    // Zoom to z2 so the point f (canvas pixels from the centre) stays under the same spot of the picture.
    const zoomAt = (z2, fx, fy) => {
      const z1 = zoom; const o = px(); const nz = clampZ(z2); const r = nz / z1;
      place(nz, fx - (fx - o.x) * r, fy - (fy - o.y) * r);
    };
    const toCanvas = (e) => {               // pointer position -> canvas pixels from the centre
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * CW - CW / 2, y: ((e.clientY - r.top) / r.height) * CH - CH / 2 };
    };
    const scaleOf = () => CW / canvas.getBoundingClientRect().width;

    const pts = new Map();                  // active pointers
    let gesture = null;                     // { z0, o0, p0 } for one finger; { z0, o0, d0, m0 } for two
    const begin = () => {
      const list = [...pts.values()];
      const o0 = px();
      if (list.length >= 2) {
        const [a, b] = list;
        gesture = { z0: zoom, o0, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      } else if (list.length === 1) gesture = { z0: zoom, o0, p0: { ...list[0] } };
      else gesture = null;
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!bmp) return;
      canvas.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      begin();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!bmp || !gesture || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const k = scaleOf();
      const rect = canvas.getBoundingClientRect();
      const list = [...pts.values()];
      if (list.length >= 2 && gesture.d0) {
        const [a, b] = list;
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const nz = clampZ(gesture.z0 * (d / gesture.d0));
        const r = nz / gesture.z0;
        // the spot under the first midpoint follows the midpoint as it moves
        const fx = ((m.x - rect.left) / rect.width) * CW - CW / 2; const fy = ((m.y - rect.top) / rect.height) * CH - CH / 2;
        const sx = ((gesture.m0.x - rect.left) / rect.width) * CW - CW / 2; const sy = ((gesture.m0.y - rect.top) / rect.height) * CH - CH / 2;
        place(nz, fx - (sx - gesture.o0.x) * r, fy - (sy - gesture.o0.y) * r);
      } else if (gesture.p0) {
        place(zoom, gesture.o0.x + (list[0].x - gesture.p0.x) * k, gesture.o0.y + (list[0].y - gesture.p0.y) * k);
      }
    });
    const lift = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size) begin();                // one finger stays down: carry on dragging from here
      else { gesture = null; commitImg(); }
    };
    canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);
    let wheelTimer = null;
    canvas.addEventListener('wheel', (e) => {
      if (!bmp) return;
      e.preventDefault();
      const f = toCanvas(e);
      zoomAt(zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), f.x, f.y);
      clearTimeout(wheelTimer); wheelTimer = setTimeout(commitImg, 200);
    }, { passive: false });
    const step = (f) => { if (!bmp) return; zoomAt(zoom * f, 0, 0); commitImg(); };
    zoomOut.onclick = () => step(1 / 1.2); zoomIn.onclick = () => step(1.2);

    const pick = h('button', { class: 'btn', type: 'button' }, 'Choose image');
    pick.onclick = async () => {
      const f = await chooseImage(); if (!f) return;
      try { bmp = await createImageBitmap(f); } catch { return toast('That file is not a picture this browser can read.'); }
      zoom = 1; ox = 0; oy = 0;
      img.hidden = true; empty.hidden = true; canvas.hidden = false; guideBox.hidden = !guides;
      drawImg(); commitImg();
    };
    const imagePane = h('div', { class: 'tp-pane' }, pick, hint, zoomOut, zoomIn);
    const guideNote = guides ? h('p', { class: 'muted small' }, 'The dashed boxes show what laptops and phones will see. Keep the important part of the picture inside them.') : null;

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
      const showEmpty = k === 'image' && !bmp;
      canvas.hidden = !showCanvas; img.hidden = showCanvas || showEmpty; empty.hidden = !showEmpty; guideBox.hidden = !(guides && showCanvas);
      useBtn.disabled = !results[k];
      if (k === 'title') { if (results.title) show(results.title.blob); else if (current) show(current); else makeTitle(); }
      if (k === 'video') { const r = results.video; if (r) show(r.blob); else if (current) show(current); }
      if (k === 'image' && bmp) drawImg();
    }

    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const m = openModal(h('h3', {}, heading), h('div', { class: 'tp-frame' }, img, canvas, empty, guideBox), h('div', { class: 'row c-tabs' }, tabBtns), panes, guideNote,
      h('div', { class: 'row tp-foot' }, h('span', { class: 'grow' }), cancel, useBtn));
    let done = false;
    const finish = (r) => { if (done) return; done = true; m.close(); resolve(r); };
    m.box.addEventListener('modal-close', () => { if (!done) { done = true; resolve(null); } });
    cancel.onclick = () => finish(null);
    useBtn.onclick = () => finish(results[mode]);
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
