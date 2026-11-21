// The lyrics editor: gives every line of a poem its start and end time, in blocks.
//
//   1. Lines are listed under a waveform. Tap the FIRST line of a block, then tap its LAST line (a whole stanza is one
//      tap away with "Select next stanza").
//   2. Play. When the first selected line begins press Start (or S). When the last one ends press End (or E), or just
//      pause: pausing also ends the block when "Pause saves the block" is on.
//   3. The lines of the block share that stretch of time in proportion to their length, and the next stanza is
//      selected. Carry on playing. Time you do not time stays empty: no lyric is shown there (a quiet moment).
//   4. Fix any line by selecting it and marking again, or nudge a selection by 0.1 s. The preview shows exactly what
//      listeners will see.
import { h, toast, fmtDur } from './ui.js';
import { drawScene, SCENE_W, SCENE_H } from '../../shared/scene.js';

const t1 = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`);
const r2 = (n) => Math.round(n * 100) / 100;

// Splits a text into rows. A blank line starts a new stanza (group). Times of an old row are kept when its text is unchanged.
export function parseRows(text, old = []) {
  const pool = old.map((o) => ({ ...o, used: false }));
  const rows = [];
  let g = 0;
  let lastBlank = false;
  for (const raw of String(text || '').split('\n')) {
    const t = raw.trim();
    if (!t) { if (rows.length && !lastBlank) g++; lastBlank = true; continue; }
    lastBlank = false;
    const m = pool.find((o) => !o.used && o.t === t);
    if (m) m.used = true;
    rows.push({ t, g, s: m ? m.s : null, e: m ? m.e : null });
  }
  return rows;
}

// Gives each text its share of [start, end], in proportion to its length. The shares touch (no gaps inside a block).
export function spreadLines(texts, start, end) {
  const w = texts.map((t) => Math.max(4, t.length));
  const total = w.reduce((a, b) => a + b, 0);
  let at = start;
  return texts.map((_, i) => {
    const s = at;
    at += ((end - start) * w[i]) / total;
    return { s: r2(s), e: i === texts.length - 1 ? r2(end) : r2(at) };
  });
}

// opts: { title, audio: Blob, rows (saved draft or null), text (starting text if no rows), anim, bg: Blob|null, onSave({ lyrics, draft }) }
export async function openLyricsEditor({ title, audio, rows: draft = null, text = '', anim = 'slide', bg = null, onSave }) {
  let rows = draft && draft.length ? draft.map((r) => ({ ...r })) : parseRows(text);
  let sel = new Set();
  let anchor = null;
  let startMark = null;
  let dirty = false;
  let dur = 0;
  let peaks = null;

  const url = URL.createObjectURL(audio);
  const player = new Audio(url);
  player.preload = 'auto';
  const bgImg = bg ? await createImageBitmap(bg).catch(() => null) : null;
  let mark = null;
  try { mark = await createImageBitmap(await (await fetch('/studio/icons/mark.png')).blob()); } catch { /* no logo */ }

  /* ---------- screen ---------- */
  const preview = h('canvas', { class: 'le-preview', width: SCENE_W / 2, height: SCENE_H / 2, 'aria-label': 'Preview' });
  const wave = h('canvas', { class: 'le-wave', height: 96, 'aria-label': 'Waveform. Tap to move.' });
  const clock = h('span', { class: 'le-clock' }, '0:00.0');
  const playBtn = h('button', { class: 'btn primary', type: 'button' }, 'Play');
  const info = h('p', { class: 'muted small le-info' });
  const list = h('div', { class: 'le-list' });
  const pauseSaves = h('input', { type: 'checkbox', checked: true });
  const startBtn = h('button', { class: 'btn', type: 'button' }, 'Start (S)');
  const endBtn = h('button', { class: 'btn', type: 'button' }, 'End and save (E)');
  const nextBtn = h('button', { class: 'btn small', type: 'button' }, 'Select next stanza');
  const clearBtn = h('button', { class: 'btn small', type: 'button' }, 'Clear time');
  const nudgeBack = h('button', { class: 'btn small', type: 'button' }, '−0.1 s');
  const nudgeFwd = h('button', { class: 'btn small', type: 'button' }, '+0.1 s');
  const editBtn = h('button', { class: 'btn small', type: 'button' }, 'Edit text');
  const closeBtn = h('button', { class: 'btn', type: 'button' }, 'Close');
  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save lyrics');

  const root = h('div', { class: 'le', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lyrics timing' },
    h('div', { class: 'le-top' }, closeBtn, h('strong', { class: 'grow' }, 'Lyrics: ' + (title || 'Untitled')), saveBtn),
    preview, wave,
    h('div', { class: 'row' }, playBtn, h('button', { class: 'btn small', type: 'button', onclick: () => { player.currentTime = Math.max(0, player.currentTime - 5); } }, '−5 s'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { player.currentTime = Math.min(dur || 1e9, player.currentTime + 5); } }, '+5 s'), clock),
    h('div', { class: 'row' }, startBtn, endBtn),
    h('label', { class: 'row check' }, pauseSaves, h('span', {}, 'Pause saves the block')),
    info,
    h('div', { class: 'row le-tools' }, nextBtn, clearBtn, nudgeBack, nudgeFwd, editBtn),
    list);
  document.body.append(root);
  document.body.classList.add('le-open');

  /* ---------- waveform ---------- */
  (async () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(await audio.arrayBuffer());
      ctx.close?.();
      dur = buf.duration;
      const n = 1200;
      const d = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(d.length / n));
      peaks = new Float32Array(n);
      for (let i = 0; i < n; i++) { let m = 0; for (let k = 0; k < step; k += 8) m = Math.max(m, Math.abs(d[i * step + k] || 0)); peaks[i] = m; }
      drawWave();
    } catch { /* no waveform: the list and the preview still work */ }
  })();
  player.addEventListener('loadedmetadata', () => { if (!dur) dur = player.duration; drawWave(); });

  function drawWave() {
    const w = (wave.width = wave.clientWidth || 600);
    const hh = wave.height;
    const c = wave.getContext('2d');
    c.clearRect(0, 0, w, hh);
    c.fillStyle = '#1d1a25';
    c.fillRect(0, 0, w, hh);
    const total = dur || player.duration || 1;
    for (const r of rows) {
      if (r.s == null) continue;
      c.fillStyle = 'rgba(134,196,173,.28)';
      c.fillRect((r.s / total) * w, 0, Math.max(1, ((r.e - r.s) / total) * w), hh);
    }
    c.fillStyle = 'rgba(229,115,106,.18)';
    for (const i of sel) { const r = rows[i]; if (r && r.s != null) c.fillRect((r.s / total) * w, 0, Math.max(1, ((r.e - r.s) / total) * w), hh); }
    if (peaks) {
      c.fillStyle = '#9a93a8';
      for (let x = 0; x < w; x++) {
        const p = peaks[Math.min(peaks.length - 1, Math.floor((x / w) * peaks.length))];
        const bh = Math.max(1, p * (hh - 8));
        c.fillRect(x, (hh - bh) / 2, 1, bh);
      }
    }
    if (startMark != null) { c.fillStyle = '#e5736a'; c.fillRect((startMark / total) * w, 0, 2, hh); }
    c.fillStyle = '#ebe5d8';
    c.fillRect((player.currentTime / total) * w, 0, 2, hh);
  }
  const seekFrom = (e) => {
    const r = wave.getBoundingClientRect();
    player.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (dur || player.duration || 0);
    tickUI();
  };
  let dragging = false;
  wave.addEventListener('pointerdown', (e) => { dragging = true; wave.setPointerCapture(e.pointerId); seekFrom(e); });
  wave.addEventListener('pointermove', (e) => { if (dragging) seekFrom(e); });
  wave.addEventListener('pointerup', () => { dragging = false; });

  /* ---------- the preview ---------- */
  const timed = () => rows.filter((r) => r.s != null && r.e != null).sort((a, b) => a.s - b.s);
  function drawPreview() {
    const c = preview.getContext('2d');
    c.save();
    c.scale(preview.width / SCENE_W, preview.height / SCENE_H);
    drawScene(c, SCENE_W, SCENE_H, { t: player.currentTime, bars: new Array(32).fill(0.04), title, bg: bgImg, mark, lyrics: timed(), anim });
    c.restore();
  }
  function tickUI() {
    clock.textContent = t1(player.currentTime) + (dur ? ' / ' + fmtDur(dur) : '');
    drawWave();
    drawPreview();
  }
  let raf = 0;
  const loop = () => { raf = 0; tickUI(); if (!player.paused) raf = requestAnimationFrame(loop); };
  player.addEventListener('play', () => { playBtn.textContent = 'Pause'; if (!raf) raf = requestAnimationFrame(loop); });
  player.addEventListener('pause', () => {
    playBtn.textContent = 'Play';
    tickUI();
    if (pauseSaves.checked && startMark != null && sel.size && player.currentTime - startMark > 0.5) endBlock();
  });
  player.addEventListener('seeked', tickUI);
  playBtn.onclick = () => { if (player.paused) player.play().catch(() => toast('Could not play this audio.')); else player.pause(); };

  /* ---------- the lines ---------- */
  const indices = () => [...sel].sort((a, b) => a - b);
  function paintInfo() {
    const idx = indices();
    info.textContent = !rows.length ? 'No lines yet. Tap Edit text and paste the lyrics.'
      : !idx.length ? 'Tap the first line of a block, then its last line. Or choose Select next stanza.'
        : startMark == null ? `${idx.length} line${idx.length === 1 ? '' : 's'} selected. Play, and press Start where the first one begins.`
          : `Started at ${t1(startMark)}. Press End (or pause) where the last selected line ends.`;
  }
  function paintList() {
    let lastG = -1;
    list.replaceChildren(...rows.flatMap((r, i) => {
      const out = [];
      if (r.g !== lastG && lastG !== -1) out.push(h('div', { class: 'le-gap' }));
      lastG = r.g;
      out.push(h('div', { class: 'le-row' + (sel.has(i) ? ' on' : '') + (r.s != null ? ' timed' : ''), onclick: () => pick(i) },
        h('button', { class: 'le-time', type: 'button', onclick: (e) => { e.stopPropagation(); if (r.s != null) { player.currentTime = r.s; tickUI(); } } }, r.s == null ? '—' : `${t1(r.s)}–${t1(r.e)}`),
        h('span', { class: 'le-text' }, r.t)));
      return out;
    }));
    paintInfo();
    drawWave();
  }
  function pick(i) {
    if (anchor == null) { anchor = i; sel = new Set([i]); } else {
      const a = Math.min(anchor, i); const b = Math.max(anchor, i);
      sel = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
      anchor = null;
    }
    paintList();
  }
  function selectNextStanza() {
    const i = rows.findIndex((r) => r.s == null);
    if (i < 0) { sel = new Set(); paintList(); return; }
    sel = new Set(rows.map((r, k) => (r.g === rows[i].g && r.s == null ? k : -1)).filter((k) => k >= 0));
    anchor = null;
    paintList();
  }
  function startBlock() {
    if (!sel.size) { selectNextStanza(); if (!sel.size) return toast('Select the lines first.'); }
    startMark = player.currentTime;
    paintInfo();
    drawWave();
  }
  function endBlock() {
    const idx = indices();
    if (startMark == null || !idx.length) return toast('Select lines and press Start first.');
    const end = player.currentTime;
    if (end - startMark < 0.3) return toast('The end must be after the start.');
    const parts = spreadLines(idx.map((i) => rows[i].t), startMark, end);
    idx.forEach((i, k) => { rows[i].s = parts[k].s; rows[i].e = parts[k].e; });
    dirty = true;
    startMark = null;
    selectNextStanza();                 // carry on with the next stanza
  }
  startBtn.onclick = startBlock;
  endBtn.onclick = endBlock;
  nextBtn.onclick = selectNextStanza;
  clearBtn.onclick = () => { indices().forEach((i) => { rows[i].s = null; rows[i].e = null; }); dirty = true; paintList(); };
  const nudge = (dt) => { indices().forEach((i) => { const r = rows[i]; if (r.s != null) { r.s = r2(Math.max(0, r.s + dt)); r.e = r2(Math.max(r.s + 0.1, r.e + dt)); } }); dirty = true; paintList(); drawPreview(); };
  nudgeBack.onclick = () => nudge(-0.1);
  nudgeFwd.onclick = () => nudge(0.1);

  editBtn.onclick = () => {
    const ta = h('textarea', { rows: 12, 'aria-label': 'Lyrics text' });
    ta.value = rows.map((r, i) => (i && r.g !== rows[i - 1].g ? '\n' : '') + r.t).join('\n');
    const apply = h('button', { class: 'btn primary', type: 'button' }, 'Use this text');
    const back = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const box = h('div', { class: 'le-edit' }, h('p', { class: 'muted small' }, 'One line per row. A blank line starts a new stanza. Lines whose text you do not change keep their times.'), ta, h('div', { class: 'row' }, back, apply));
    list.replaceChildren(box);
    back.onclick = paintList;
    apply.onclick = () => { rows = parseRows(ta.value, rows); sel = new Set(); anchor = null; startMark = null; dirty = true; paintList(); };
    ta.focus();
  };

  /* ---------- keys, closing, saving ---------- */
  const onKey = (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); startBlock(); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); endBlock(); }
    else if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
  };
  document.addEventListener('keydown', onKey);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    player.pause();
    URL.revokeObjectURL(url);
    root.remove();
    document.body.classList.remove('le-open');
  };
  closeBtn.onclick = () => { if (dirty && !confirm('Close without saving the lyrics?')) return; close(); };
  saveBtn.onclick = async () => {
    const lyrics = timed().map((r) => ({ s: r2(r.s), e: r2(r.e), t: r.t }));
    try { await onSave({ lyrics, draft: rows.map((r) => ({ t: r.t, g: r.g, s: r.s, e: r.e })) }); dirty = false; toast(lyrics.length ? `Saved ${lyrics.length} timed line${lyrics.length === 1 ? '' : 's'}.` : 'Saved. No line has a time yet.'); close(); }
    catch (e) { toast(e.message || String(e)); }
  };

  paintList();
  tickUI();
  if (!rows.length) editBtn.click();
}
