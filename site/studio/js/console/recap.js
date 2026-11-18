// The recap: what you do with the recording after a live. It replaces the old "After the live" card.
//  - a waveform with a playhead, two trim handles and a tick for every timestamp
//  - the timestamp list (rename, change kind, delete, add at the playhead, tap to jump)
//  - "Publish a clip": cut any part (to the second) into its own Studio audio item, as many times as you like
//  - "Publish whole recap": the same as before (the whole recording becomes the replay of this live)
// Cutting is done on this laptop without re-encoding (webm-cut.js), so there is nothing to download.
import { db } from '../db.js';
import { getBlob } from '../sync.js';
import { h, toast, probeDuration } from '../ui.js';
import { createDraftFromClip, publishItemNow } from '../publish.js';
import { jobFor, onPublishJobs } from '../publisher.js';
import { indexWebm, cutWebm, frameSizes } from './webm-cut.js';

const C = { accent: '#86c4ad', rec: '#e5736a', line: '#2e2a3a', muted: '#9a93a8', text: '#ebe5d8', bg: '#14121a' };
const WAVE_H = 96;

export const clock = (s) => {
  s = Math.max(0, Math.round(s));
  const hh = Math.floor(s / 3600); const mm = Math.floor(s / 60) % 60; const ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};
// "83", "1:23" and "1:02:03" all work. Returns NaN when it cannot be read.
export const parseClock = (text) => {
  const parts = String(text).trim().split(':').map((x) => Number(x));
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((total, n) => total * 60 + n, 0);
};

// opts: { engine, itemId, title, cap, published(), publishWhole(cap), refresh() }
export async function recapPane(opts) {
  const { engine, itemId, cap } = opts;
  const total = Math.max(1, cap?.duration || 1);
  const st = { start: 0, end: total, drag: null, blob: null, index: null, peaks: [], busy: false, markKey: '', clipKey: '', published: false, uploaded: false };
  let audio = null; let url = null; let raf = 0; let dead = false;

  /* ----- header ----- */
  const note = h('p', { class: 'small muted' });
  const whole = h('button', { class: 'btn primary', type: 'button' }, 'Publish whole recap');
  whole.onclick = async () => {
    whole.disabled = true; whole.textContent = 'Publishing…';
    try { await opts.publishWhole(cap); toast('Replay published.'); } catch (e) { toast(e.message || String(e)); }
    await checkState(true);
  };
  const head = h('div', { class: 'row rc-head' }, h('div', { class: 'grow' }, h('h3', {}, `${opts.title} · Recap`), note), whole);

  /* ----- waveform ----- */
  const canvas = h('canvas', { class: 'rc-wave', height: WAVE_H, 'aria-label': 'Recording waveform. Click to move the playhead, drag the green handles to trim.' });
  const playBtn = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Play' }, '▶');
  const timeEl = h('span', { class: 'small muted rc-time' });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 1, 'aria-label': 'Volume' });
  vol.oninput = () => { if (audio) audio.volume = Number(vol.value); };
  const wave = h('div', {}, canvas, h('div', { class: 'row rc-ctl' }, playBtn, timeEl, h('span', { class: 'grow' }), h('span', { class: 'small muted' }, 'Vol'), h('div', { style: 'width:100px' }, vol)));

  const now = () => (audio ? audio.currentTime : 0);
  const ensureAudio = () => {
    if (audio || !st.blob) return audio;
    url = URL.createObjectURL(st.blob);
    audio = new Audio(url);
    audio.volume = Number(vol.value);
    audio.onended = () => { playBtn.textContent = '▶'; draw(); };
    audio.onerror = () => toast('This recording could not be played here.');
    return audio;
  };
  const seekTo = (sec) => { const a = ensureAudio(); if (!a) return; a.currentTime = Math.min(total, Math.max(0, sec)); draw(); };
  const play = async (from) => {
    const a = ensureAudio(); if (!a) return toast('The recording is not on this device.');
    if (from != null) a.currentTime = from;
    try { await a.play(); playBtn.textContent = '❚❚'; loop(); } catch { toast('The browser did not start the audio.'); }
  };
  playBtn.onclick = () => { if (audio && !audio.paused) { audio.pause(); playBtn.textContent = '▶'; draw(); } else play(); };
  const loop = () => { cancelAnimationFrame(raf); const step = () => { draw(); if (audio && !audio.paused && !dead) raf = requestAnimationFrame(step); }; raf = requestAnimationFrame(step); };

  const xOf = (sec) => (sec / total) * canvas.clientWidth;
  const secOf = (x) => Math.min(total, Math.max(0, (x / canvas.clientWidth) * total));
  function draw() {
    const w = canvas.clientWidth; if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(WAVE_H * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, WAVE_H);
    g.fillStyle = C.bg; g.fillRect(0, 0, w, WAVE_H);
    // bars: the loudest value in each column
    const pk = st.peaks; const n = pk.length;
    const mid = WAVE_H / 2;
    for (let x = 0; x < w; x++) {
      let v = 0.04;
      if (n) { const a = Math.floor((x / w) * n); const b = Math.max(a + 1, Math.floor(((x + 1) / w) * n)); let m = 0; for (let i = a; i < b && i < n; i++) m = Math.max(m, pk[i]); v = Math.max(0.04, m / 100); }
      const inside = x >= xOf(st.start) && x <= xOf(st.end);
      g.fillStyle = inside ? C.accent : C.line;
      const hh = Math.max(1, v * (WAVE_H - 24));
      g.fillRect(x, mid - hh / 2 + 4, 1, hh);
    }
    // timestamp ticks along the top
    for (const m of engine.s.markers) { g.fillStyle = m.kind === 'poem' ? C.accent : C.muted; g.fillRect(Math.round(xOf(m.t)), 0, 2, 10); }
    // trim handles
    for (const [sec, left] of [[st.start, true], [st.end, false]]) {
      const x = Math.round(xOf(sec));
      g.fillStyle = C.accent; g.fillRect(x - 1, 0, 3, WAVE_H);
      g.fillRect(left ? x : x - 8, WAVE_H - 14, 9, 14);
    }
    // playhead
    const px = Math.round(xOf(now()));
    g.fillStyle = C.rec; g.fillRect(px - 1, 0, 2, WAVE_H);
    timeEl.textContent = `${clock(now())} / ${clock(total)}`;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left;
    const near = (sec) => Math.abs(xOf(sec) - x) <= 10;
    st.drag = near(st.start) && (!near(st.end) || x < (xOf(st.start) + xOf(st.end)) / 2) ? 'start' : near(st.end) ? 'end' : 'seek';
    canvas.setPointerCapture(e.pointerId);
    move(e);
  });
  const move = (e) => {
    if (!st.drag) return;
    const r = canvas.getBoundingClientRect(); const sec = secOf(e.clientX - r.left);
    if (st.drag === 'seek') seekTo(sec);
    else { st.drag === 'start' ? (st.start = Math.min(sec, st.end - 1)) : (st.end = Math.max(sec, st.start + 1)); syncClipInputs(); draw(); }
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', () => { st.drag = null; });

  /* ----- timestamps ----- */
  const marks = h('div', { class: 'rc-marks' });
  const addMark = h('button', { class: 'btn small', type: 'button' }, '+ Add timestamp at playhead');
  addMark.onclick = () => saveMarks([...engine.s.markers, { t: Math.round(now()), label: 'Timestamp', kind: 'dead moment' }]);
  const saveMarks = async (list) => { try { await engine.setMarkers(list); } catch (e) { toast('Could not save the timestamps: ' + (e.message || e)); } paintMarks(); draw(); };

  function paintMarks() {
    const list = engine.s.markers;
    const key = JSON.stringify(list);
    if (key === st.markKey) return;
    st.markKey = key;
    marks.replaceChildren(...(list.length ? list.map((m, i) => {
      const name = h('input', { class: 'inline rc-mname', value: m.label, maxlength: 80, 'aria-label': 'Timestamp name' });
      name.onchange = () => saveMarks(list.map((x, j) => (j === i ? { ...x, label: name.value.trim() || 'Timestamp' } : x)));
      const kind = h('button', { class: 'rc-kind ' + (m.kind === 'poem' ? 'poem' : ''), type: 'button', title: 'Tap to change' }, m.kind === 'poem' ? 'poem' : 'dead moment');
      kind.onclick = () => saveMarks(list.map((x, j) => (j === i ? { ...x, kind: x.kind === 'poem' ? 'dead moment' : 'poem' } : x)));
      const next = list[i + 1] ? list[i + 1].t : total;
      return h('div', { class: 'rc-mark' },
        h('button', { class: 'lnk rc-t', type: 'button', title: 'Jump here', onclick: () => seekTo(m.t) }, clock(m.t)),
        h('div', { class: 'grow' }, name), kind,
        h('button', { class: 'btn small', type: 'button', title: 'Play from here', 'aria-label': 'Play from here', onclick: () => play(m.t) }, '▶'),
        h('button', { class: 'lnk', type: 'button', title: 'Use this part for a clip', onclick: () => { st.start = m.t; st.end = Math.max(m.t + 1, next); syncClipInputs(); draw(); } }, 'clip'),
        h('button', { class: 'lnk', type: 'button', title: 'Delete', 'aria-label': 'Delete', onclick: () => saveMarks(list.filter((_, j) => j !== i)) }, '✕'));
    }) : [h('p', { class: 'small muted' }, 'No timestamps yet. They are added when a poem or file starts in the Deck, or with Add timestamp.')]));
  }

  /* ----- publish a clip ----- */
  const titleIn = h('input', { value: `${opts.title} · clip`, maxlength: 120, 'aria-label': 'Clip title' });
  const startIn = h('input', { class: 'inline rc-clockin', 'aria-label': 'Start' });
  const endIn = h('input', { class: 'inline rc-clockin', 'aria-label': 'End' });
  const lenEl = h('span', { class: 'small muted' });
  const msg = h('p', { class: 'small' });
  const clipBtn = h('button', { class: 'btn primary', type: 'button' }, 'Publish clip');
  function syncClipInputs() {
    if (document.activeElement !== startIn) startIn.value = clock(st.start);
    if (document.activeElement !== endIn) endIn.value = clock(st.end);
    lenEl.textContent = `Length ${clock(Math.max(0, st.end - st.start))}`;
  }
  const readIn = (input, which) => {
    const v = parseClock(input.value);
    if (!Number.isFinite(v)) { syncClipInputs(); return; }
    if (which === 'start') st.start = Math.min(v, st.end - 1); else st.end = Math.min(total, Math.max(v, st.start + 1));
    st.start = Math.max(0, st.start); syncClipInputs(); draw();
  };
  startIn.onchange = () => readIn(startIn, 'start'); endIn.onchange = () => readIn(endIn, 'end');
  const here = (which) => () => { const v = Math.round(now()); if (which === 'start') st.start = Math.min(v, st.end - 1); else st.end = Math.max(v, st.start + 1); syncClipInputs(); draw(); };

  clipBtn.onclick = async () => {
    if (st.busy) return;
    const title = titleIn.value.trim();
    if (!title) { msg.textContent = 'Give the clip a title.'; return; }
    if (st.end - st.start < 1) { msg.textContent = 'Pick a part that is at least a second long.'; return; }
    st.busy = true; clipBtn.disabled = true; msg.className = 'small'; msg.textContent = 'Cutting…';
    try {
      if (!st.blob) throw new Error('The recording is not on this device.');
      st.index ||= await indexWebm(st.blob);
      const cut = cutWebm(st.index, st.start * 1000, st.end * 1000);
      if (!(await probeDuration(cut.blob))) throw new Error('The cut did not produce playable audio.');
      const id = await createDraftFromClip({ liveId: itemId, title, blob: cut.blob, duration: cut.durationMs / 1000 });
      publishItemNow(id, title).then(() => paintClips(true), () => paintClips(true));
      msg.textContent = `Clip "${title}" is on its way (${clock(cut.durationMs / 1000)}).`;
      toast('Clip queued for publishing.');
      paintClips(true);
    } catch (e) { msg.className = 'small error'; msg.textContent = e.message || String(e); }
    st.busy = false; clipBtn.disabled = false;
  };
  const clipBox = h('div', { class: 'rc-clip' }, h('h4', {}, 'Publish a clip'), titleIn,
    h('div', { class: 'row rc-cliprow' }, h('span', { class: 'small muted' }, 'Start'), startIn, h('button', { class: 'lnk', type: 'button', onclick: here('start') }, 'at playhead'),
      h('span', { class: 'small muted' }, 'End'), endIn, h('button', { class: 'lnk', type: 'button', onclick: here('end') }, 'at playhead'), lenEl),
    h('div', { class: 'row' }, clipBtn), msg);

  /* ----- clips made from this recap ----- */
  const clipsBox = h('div', { class: 'rc-clips' });
  async function paintClips(force) {
    const rows = (await db.items.filter((x) => x.liveId === itemId).toArray()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const stateOf = (r) => {
      const j = jobFor(r.id);
      if (r.status === 'published') return 'Published';
      if (j && ['queued', 'running', 'waiting'].includes(j.state)) return `${j.label}${j.pct ? ` ${j.pct}%` : ''}`;
      if (j && j.state === 'error') return `Failed: ${j.error}`;
      return 'Draft';
    };
    const key = rows.map((r) => `${r.id}:${stateOf(r)}`).join('|');
    if (!force && key === st.clipKey) return;
    st.clipKey = key;
    clipsBox.replaceChildren(h('h4', {}, 'Published from this recap'), ...(rows.length ? rows.map((r) => {
      const s = stateOf(r);
      return h('div', { class: 'rc-clipitem' }, h('span', { class: 'grow' }, r.title), h('span', { class: 'small muted' }, clock(r.duration || 0)),
        h('span', { class: 'small ' + (s.startsWith('Failed') ? 'error' : s === 'Published' ? '' : 'muted') }, s),
        s === 'Draft' || s.startsWith('Failed') ? h('button', { class: 'lnk', type: 'button', onclick: () => { publishItemNow(r.id, r.title).then(() => paintClips(true), () => paintClips(true)); paintClips(true); } }, 'Retry') : null);
    }) : [h('p', { class: 'small muted' }, 'Nothing yet.')]));
  }
  const offJobs = onPublishJobs(() => paintClips());

  /* ----- state: is the recording ready, is it already the replay ----- */
  let lastCheck = 0;
  async function checkState(force) {
    if (!force && Date.now() - lastCheck < 15000) return;
    lastCheck = Date.now();
    try { st.published = await opts.published(); } catch { /* keep the last answer */ }
    const fresh = cap ? await db.captures.get(cap.id) : null;
    st.uploaded = !!(fresh && fresh.status === 'done' && !fresh.blobPending);
    note.textContent = !cap ? 'No recording was made on this device for this live.'
      : `${st.uploaded ? 'Saved to your private storage' : fresh?.status !== 'done' ? 'Finishing the recording…' : 'Uploading to your private storage. Keep the app open and online.'} · ${clock(total)} long`;
    whole.textContent = st.published ? 'Replay is published' : 'Publish whole recap';
    whole.disabled = st.published || !st.uploaded;
  }

  const el = h('section', { class: 'card c-recap' }, head, wave, h('h4', {}, 'Timestamps'), marks, addMark, clipBox, clipsBox);

  function paint() { checkState(false); paintMarks(); paintClips(); syncClipInputs(); }

  // the recording itself, and the level history saved while it was recorded
  if (cap) {
    st.blob = await getBlob('captures', cap);
    const saved = (await db.meta.get(`peaks:${cap.id}`))?.value;
    if (saved?.length) st.peaks = saved;
    else if (st.blob && /webm/i.test(st.blob.type || cap.mime || '')) {
      // an older recording: a rough waveform from the size of the encoded audio, read in the background
      indexWebm(st.blob).then((idx) => { st.index = idx; const sizes = frameSizes(idx); const top = Math.max(1, ...sizes); st.peaks = sizes.map((v) => Math.round((v / top) * 100)); draw(); }).catch(() => {});
    }
  }
  if (!st.blob) { clipBtn.disabled = true; playBtn.disabled = true; msg.textContent = 'The recording is not on this device yet.'; }
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  paintMarks(); await paintClips(true); await checkState(true); syncClipInputs();
  setTimeout(draw, 30);
  return { el, paint, dispose() { dead = true; cancelAnimationFrame(raf); offJobs(); window.removeEventListener('resize', onResize); if (audio) { audio.pause(); audio = null; } if (url) URL.revokeObjectURL(url); } };
}
