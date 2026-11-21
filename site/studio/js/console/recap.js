// The recap: what you do with the recording after a live.
//  - SEGMENTS: a segment runs from one timestamp to the next (the first from 0:00, the last to the end).
//    Each one has its own play button (only one plays at a time) and its own Publish button.
//  - JOIN: tick two or more segments and press "Join & publish" (they need not be next to each other).
//  - Everything published from here is a NEW post with its own, fresh numbers. The live keeps its own stats.
//  - A post is at most 10 minutes. A longer live is published "in parts" (cut at your timestamps, never over 10 minutes);
//    all the parts of one live play together as that live's ALBUM (a single part makes an album of one).
//  - The waveform is only a picture of the recording (click it to play from that point).
//  - On the right, read-only: the saved Chats and the Viewers of this live.
// Cutting and joining happen on this laptop without re-encoding (webm-cut.js), so nothing is downloaded.
import { db } from '../db.js';
import { sb } from '../../../shared/supabase.js';
import { getBlob } from '../sync.js';
import { h, toast, probeDuration, eyeIcon, loveIcon } from '../ui.js';
import { createDraftFromClip, publishItemNow } from '../publish.js';
import { jobFor, onPublishJobs } from '../publisher.js';
import { indexWebm, cutWebm, frameSizes } from './webm-cut.js';
import { thumbField } from '../thumb-picker.js';

const C = { accent: '#86c4ad', pick: '#4f8a75', rec: '#e5736a', line: '#2e2a3a', muted: '#9a93a8', text: '#ebe5d8', bg: '#14121a' };
const WAVE_H = 72;
const MAX_PART = 600;   // seconds: the longest a published post can be

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

const GUEST = /^Guest [0-9a-f]{4}$/;

// Everything the recap shows about the live, read from what was saved (never from the room): counters, the peak,
// Love, the chat (saved while the live ran) and the viewer log (saved when it ended, migration 007).
// A query that fails (a table that is not there yet, for instance) just leaves its part out.
async function loadSaved(itemId, hostName) {
  const ok = async (q) => { try { const r = await q; return r.error ? null : r.data; } catch { return null; } };
  const pages = async (make) => {
    const out = [];
    for (let from = 0; from < 5000; from += 1000) {
      const part = await ok(make().range(from, from + 999));
      if (!part) return out.length ? out : null;
      out.push(...part);
      if (part.length < 1000) break;
    }
    return out;
  };
  const [counter, session, log, comments, love] = await Promise.all([
    ok(sb.from('counters').select('n_views').eq('item_id', itemId).maybeSingle()),
    ok(sb.from('live_sessions').select('peak_viewers,started_at,ended_at').eq('item_id', itemId).maybeSingle()),
    ok(sb.from('live_log').select('*').eq('item_id', itemId).maybeSingle()),
    pages(() => sb.from('comments').select('id,user_id,nickname,body,created_at,hidden').eq('item_id', itemId).order('created_at', { ascending: true })),
    pages(() => sb.from('live_love').select('user_id,taps').eq('item_id', itemId).order('taps', { ascending: false })),
  ]);
  const chat = (comments || []).filter((c) => !c.hidden).map((c) => ({ id: c.id, uid: c.user_id, name: c.nickname || 'Guest', text: c.body, at: Date.parse(c.created_at), host: !!hostName && c.nickname === hostName }));
  const loveSum = (love || []).reduce((n, r) => n + (r.taps || 0), 0);
  const out = {
    views: counter ? counter.n_views || 0 : null,
    peak: session ? session.peak_viewers || 0 : null,
    love: log ? log.love_total || 0 : (love ? loveSum : null),
    startedAt: session?.started_at ? Date.parse(session.started_at) : 0,
    chat, haveChat: comments != null,
    viewers: [], viewersSaved: false, total: null, guests: null,
  };
  if (log) {
    out.viewersSaved = true;
    out.viewers = (log.viewers || []).map((v) => ({ name: v.name, uid8: v.uid8, joinedAt: v.joined_at ? Date.parse(v.joined_at) : null, messages: v.messages || 0, love: v.love || 0 }));
    out.total = log.total_viewers || 0; out.guests = log.anon_viewers || 0;
  } else {
    // A live that ended before the viewer log existed: only what is truly known. People who chatted or sent Love, no join times.
    const by = new Map();
    for (const c of chat) { if (c.host) continue; const v = by.get(c.uid) || { name: c.name, uid8: String(c.uid).slice(0, 4), joinedAt: null, messages: 0, love: 0 }; v.messages++; v.name = c.name; by.set(c.uid, v); }
    for (const r of love || []) { const v = by.get(r.user_id) || { name: `Viewer`, uid8: String(r.user_id).slice(0, 4), joinedAt: null, messages: 0, love: 0 }; v.love = r.taps || 0; by.set(r.user_id, v); }
    let guests = 0;
    for (const [uid, v] of [...by]) if (GUEST.test(v.name)) { guests++; by.delete(uid); }
    out.viewers = [...by.values()];
    out.guests = guests;
  }
  return out;
}

// opts: { engine, itemId, title, cap, published() }
export async function recapPane(opts) {
  const { engine, itemId, cap } = opts;
  const total = Math.max(1, cap?.duration || 1);
  const st = {
    blob: null, index: null, peaks: [], busy: false, uploaded: false, published: false,
    head: 0,                 // the playhead when nothing plays (where "+ Timestamp" goes)
    playing: null,           // { i, start, end } while a segment plays
    sel: new Set(),          // ticked segments (their start times)
    open: null,              // the segment whose publish form is open (its start time)
    joinTitle: '', joinEdited: false, wholeOpen: false,
    fields: new Map(),       // per open form: its title and its thumbnail field, kept while the list is redrawn
    segKey: '', clipKey: '', panelKey: '', tab: 'chats',
    saved: null, savedAt: 0, loading: false,
  };
  let audio = null; let url = null; let raf = 0; let dead = false;
  const liveTitle = () => engine.s.row?.title || opts.title;
  const hostName = () => engine.s.row?.settings?.hostName || '';

  /* ----- header: title, the numbers of this live, and "Publish whole recap" ----- */
  const note = h('p', { class: 'small muted' });
  const stat = (icon, label) => { const v = h('b', {}, '–'); return { v, el: h('span', { class: 'rc-st', title: label }, icon, v, h('span', { class: 'rc-stl' }, label)) }; };
  const sViews = stat(eyeIcon(14), 'Views'); const sPeak = stat(h('span', { class: 'stat-live', 'aria-hidden': 'true' }), 'Peak watching'); const sLove = stat(loveIcon(14), 'Love');
  sLove.el.classList.add('is-love');
  const whole = h('button', { class: 'btn primary small', type: 'button' }, total > MAX_PART + 0.5 ? 'Publish in parts' : 'Publish whole recap');
  const head = h('div', { class: 'row rc-top' }, h('div', { class: 'grow' }, h('h3', {}, `${opts.title} · Recap`), note), h('div', { class: 'rc-stats' }, sViews.el, sPeak.el, sLove.el), whole);
  const wholeForm = h('div', { class: 'rc-form', hidden: true });

  /* ----- waveform (a picture; click it to play from there) ----- */
  const canvas = h('canvas', { class: 'rc-wave', height: WAVE_H, 'aria-label': 'Recording waveform. Click a point to play the segment from there.' });
  const timeEl = h('span', { class: 'small muted rc-time' });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 1, 'aria-label': 'Volume' });
  vol.oninput = () => { if (audio) audio.volume = Number(vol.value); };
  const wave = h('div', { class: 'rc-wavebox' }, canvas, h('div', { class: 'row rc-ctl' }, timeEl, h('span', { class: 'grow' }), h('span', { class: 'small muted' }, 'Vol'), h('div', { style: 'width:90px' }, vol)));

  const now = () => (audio && st.playing ? audio.currentTime : st.head);
  const ensureAudio = () => {
    if (audio || !st.blob) return audio;
    url = URL.createObjectURL(st.blob);
    audio = new Audio(url);
    audio.volume = Number(vol.value);
    audio.onended = () => stopPlay(true);
    audio.onerror = () => toast('This recording could not be played here.');
    return audio;
  };

  /* ----- segments: from one timestamp to the next ----- */
  function segments() {
    const pts = [...engine.s.markers].map((m) => ({ t: Math.min(total, Math.max(0, m.t)), label: m.label || 'Timestamp', kind: m.kind, marker: m })).sort((a, b) => a.t - b.t);
    const list = [];
    if (!pts.length || pts[0].t > 0) list.push({ t: 0, label: pts.length ? 'Start' : 'Whole recording', implicit: true, kind: 'dead moment' });
    for (const p of pts) list.push(p);
    return list.map((s, i) => ({ ...s, i, start: s.t, end: i + 1 < list.length ? list[i + 1].t : total }));
  }
  const segAt = (sec) => { const segs = segments(); let k = 0; for (const s of segs) if (s.start <= sec) k = s.i; return segs[k]; };

  // atEnd: the segment ran to its end (the playhead rests there); otherwise it was stopped where it was.
  function stopPlay(atEnd) {
    cancelAnimationFrame(raf);
    if (audio && !audio.paused) audio.pause();
    if (st.playing) st.head = atEnd ? st.playing.end : Math.min(total, audio ? audio.currentTime : st.head);
    st.playing = null;
    paintSegs(true); draw();
  }
  async function playSeg(seg, from) {
    const a = ensureAudio(); if (!a) return toast('The recording is not on this device.');
    if (seg.end - seg.start < 0.5) return toast('That segment is too short to play.');
    st.playing = { i: seg.i, start: seg.start, end: seg.end };
    a.currentTime = from != null ? Math.min(seg.end - 0.1, Math.max(seg.start, from)) : seg.start;   // only one plays: this replaces what was playing
    try { await a.play(); } catch { st.playing = null; paintSegs(true); return toast('The browser did not start the audio.'); }
    paintSegs(true); loop();
  }
  const loop = () => {
    cancelAnimationFrame(raf);
    const step = () => {
      if (dead || !audio || !st.playing) return;
      if (audio.currentTime >= st.playing.end - 0.03) return stopPlay(true);
      draw();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const xOf = (sec) => (sec / total) * canvas.clientWidth;
  function draw() {
    const w = canvas.clientWidth; if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(WAVE_H * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, WAVE_H);
    g.fillStyle = C.bg; g.fillRect(0, 0, w, WAVE_H);
    const segs = segments();
    const colOf = (sec) => { const s = segAt(sec); return st.playing && s.i === st.playing.i ? C.accent : st.sel.has(s.start) ? C.pick : C.line; };
    const pk = st.peaks; const n = pk.length; const mid = WAVE_H / 2;
    for (let x = 0; x < w; x++) {
      let v = 0.04;
      if (n) { const a = Math.floor((x / w) * n); const b = Math.max(a + 1, Math.floor(((x + 1) / w) * n)); let m = 0; for (let i = a; i < b && i < n; i++) m = Math.max(m, pk[i]); v = Math.max(0.04, m / 100); }
      g.fillStyle = colOf((x / w) * total);
      const hh = Math.max(1, v * (WAVE_H - 20));
      g.fillRect(x, mid - hh / 2 + 4, 1, hh);
    }
    for (const s of segs) { if (s.start <= 0) continue; const x = Math.round(xOf(s.start)); g.fillStyle = s.kind === 'poem' ? C.accent : C.muted; g.fillRect(x, 0, 2, WAVE_H); g.fillStyle = 'rgba(20,18,26,.55)'; g.fillRect(x + 2, 0, 1, WAVE_H); }
    const px = Math.round(xOf(now()));
    g.fillStyle = C.rec; g.fillRect(px - 1, 0, 2, WAVE_H);
    timeEl.textContent = `${clock(now())} / ${clock(total)}`;
  }
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const sec = Math.min(total, Math.max(0, ((e.clientX - r.left) / canvas.clientWidth) * total));
    st.head = sec;
    playSeg(segAt(sec), sec);
  });

  /* ----- saving timestamps (the recap edits the whole list at once) ----- */
  const saveMarks = async (list) => { try { await engine.setMarkers(list); } catch (e) { toast('Could not save the timestamps: ' + (e.message || e)); } paintSegs(); draw(); };
  const addMark = h('button', { class: 'btn small', type: 'button' }, '+ Timestamp at playhead');
  addMark.onclick = () => saveMarks([...engine.s.markers, { t: Math.round(now()), label: 'Timestamp', kind: 'dead moment' }]);

  /* ----- publishing: the inline form, used for one segment, for several joined ones and for the whole recap ----- */
  const msg = h('p', { class: 'small rc-msg' });
  async function publishRanges(title, ranges, what, tf) {
    if (st.busy) return false;
    title = String(title || '').trim();
    if (!title) { msg.className = 'small error rc-msg'; msg.textContent = 'Give it a title.'; return false; }
    st.busy = true; msg.className = 'small rc-msg'; msg.textContent = 'Cutting…';
    try {
      if (!st.blob) throw new Error('The recording is not on this device.');
      let blob = st.blob; let seconds = total;
      if (!ranges && total > MAX_PART + 0.5) throw new Error('A post can be at most 10 minutes. Use "Publish in parts".');
      if (ranges && ranges.reduce((n, [a, b]) => n + (b - a), 0) > MAX_PART + 0.5) throw new Error('A post can be at most 10 minutes. Pick a shorter range, or add a timestamp to split it.');
      if (ranges) {
        if (ranges.some(([a, b]) => b - a < 1)) throw new Error('Every part must be at least a second long.');
        st.index ||= await indexWebm(st.blob);
        const cut = cutWebm(st.index, ranges.map(([a, b]) => [a * 1000, b * 1000]));
        if (!(await probeDuration(cut.blob))) throw new Error('The cut did not produce playable audio.');
        blob = cut.blob; seconds = cut.durationMs / 1000;
      }
      const t = tf ? await tf.get() : null;   // the thumbnail picked for this post, or a title card
      const id = await createDraftFromClip({ liveId: itemId, title, blob, duration: seconds, thumb: t?.blob, thumbKind: t?.kind, thumbLook: t?.look || 0, albumTitle: liveTitle(), albumPos: ranges ? ranges[0][0] : 0 });
      publishItemNow(id, title).then(() => paintClips(true), () => paintClips(true));
      msg.textContent = `${what} "${title}" is on its way (${clock(seconds)}). It is a new post with fresh numbers.`;
      toast('Queued for publishing.');
      paintClips(true);
      st.busy = false;
      return true;
    } catch (e) { msg.className = 'small error rc-msg'; msg.textContent = e.message || String(e); st.busy = false; return false; }
  }

  // One shared record per open form (its title and its thumbnail field), so redrawing the list never loses what was typed or picked.
  const fieldFor = (key, def) => {
    if (!st.fields.has(key)) { const rec = { title: def }; rec.tf = thumbField({ getTitle: () => rec.title }); st.fields.set(key, rec); }
    return st.fields.get(key);
  };
  function formFor({ key, value, label, onGo, onCancel }) {
    const rec = fieldFor(key, value);
    const input = h('input', { value: rec.title, maxlength: 120, 'aria-label': 'Title' });
    let t = 0;
    input.oninput = () => { rec.title = input.value; clearTimeout(t); t = setTimeout(() => rec.tf.refresh(), 400); };
    const go = h('button', { class: 'btn primary small', type: 'button' }, label);
    const close = () => { st.fields.delete(key); onCancel(); };
    go.onclick = async () => { go.disabled = true; const ok = await onGo(input.value, rec.tf); go.disabled = false; if (ok) close(); };
    input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    return { input, el: h('div', { class: 'rc-formbox' }, h('div', { class: 'row rc-formrow' }, h('div', { class: 'grow' }, input), go, h('button', { class: 'btn small', type: 'button', onclick: close }, 'Cancel')), rec.tf.el) };
  }

  // A live longer than 10 minutes: proposes parts (cut at your timestamps, each at most 10 minutes) and publishes them all.
  function proposeParts() {
    const parts = [];
    let cur = null;
    const flush = () => { if (cur && cur.end - cur.start >= 1) parts.push(cur); cur = null; };
    for (const s of segments()) {
      const len = s.end - s.start;
      if (len > MAX_PART) {                                  // too long for one post: cut it into equal pieces
        flush();
        const n = Math.ceil(len / MAX_PART);
        for (let k = 0; k < n; k++) parts.push({ start: s.start + (len * k) / n, end: s.start + (len * (k + 1)) / n });
      } else if (cur && cur.end === s.start && cur.end - cur.start + len <= MAX_PART) cur.end = s.end;
      else { flush(); cur = { start: s.start, end: s.end }; }
    }
    flush();
    return parts.map((p) => ({ start: Math.round(p.start * 10) / 10, end: Math.round(p.end * 10) / 10 }));
  }
  function partsForm() {
    const parts = proposeParts();
    const titles = parts.map((_, i) => `${liveTitle()} · Part ${i + 1}`);
    const rows = parts.map((p, i) => {
      const input = h('input', { value: titles[i], maxlength: 120, 'aria-label': `Title of part ${i + 1}` });
      input.oninput = () => { titles[i] = input.value; };
      return h('div', { class: 'row rc-formrow' }, h('span', { class: 'small muted' }, `${clock(p.start)} – ${clock(p.end)} · ${clock(p.end - p.start)}`), h('div', { class: 'grow' }, input));
    });
    const go = h('button', { class: 'btn primary small', type: 'button' }, `Publish ${parts.length} part${parts.length === 1 ? '' : 's'}`);
    go.onclick = async () => {
      go.disabled = true;
      let done = 0;
      for (let i = 0; i < parts.length; i++) {
        msg.className = 'small rc-msg'; msg.textContent = `Part ${i + 1} of ${parts.length}…`;
        const ok = await publishRanges(titles[i], [[parts[i].start, parts[i].end]], `Part ${i + 1}`, null);
        if (!ok) break;
        done++;
      }
      go.disabled = false;
      if (done === parts.length) { st.wholeOpen = false; wholeForm.hidden = true; msg.textContent = `All ${done} parts are on their way. They play together as the album "${liveTitle()}".`; }
    };
    wholeForm.replaceChildren(
      h('p', { class: 'small muted' }, `This live is ${clock(total)} long, and a post can be at most 10 minutes. These parts are cut at your timestamps. They become one album named after the live, and play on from one to the next. You can rename each part.`),
      ...rows, h('div', { class: 'row rc-formrow' }, go, h('button', { class: 'btn small', type: 'button', onclick: () => { st.wholeOpen = false; wholeForm.hidden = true; } }, 'Cancel')));
  }
  whole.onclick = () => {
    if (st.wholeOpen) { st.wholeOpen = false; wholeForm.hidden = true; return; }
    if (total > MAX_PART + 0.5) { st.wholeOpen = true; wholeForm.hidden = false; partsForm(); return; }
    st.wholeOpen = true; wholeForm.hidden = false;
    const f = formFor({ key: 'whole', value: `${liveTitle()} · full recap`, label: 'Publish', onGo: (t, tf) => publishRanges(t, null, 'Recap', tf), onCancel: () => { st.wholeOpen = false; wholeForm.hidden = true; } });
    wholeForm.replaceChildren(h('p', { class: 'small muted' }, 'This makes a NEW post from the whole recording. The live keeps its own numbers.'), f.el);
    f.input.focus(); f.input.select();
  };

  /* ----- the segment list ----- */
  const segsBox = h('div', { class: 'rc-segs' });
  const joinBar = h('div', { class: 'rc-join', hidden: true });
  const segTitle = (s) => `${liveTitle()} · ${s.label} · ${clock(s.start)}`;

  function paintSegs(force) {
    const segs = segments();
    // ticks that no longer match a segment are dropped
    for (const t of [...st.sel]) if (!segs.some((s) => s.start === t)) st.sel.delete(t);
    const key = JSON.stringify([segs.map((s) => [s.start, s.end, s.label, s.kind]), [...st.sel], st.open, st.playing?.i ?? -1, st.busy]);
    if (!force && key === st.segKey) return;
    if (!force && segsBox.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // never redraw under the person's typing
    st.segKey = key;
    const rows = segs.map((s) => {
      const len = s.end - s.start;
      const playing = st.playing?.i === s.i;
      const tick = h('input', { type: 'checkbox', checked: st.sel.has(s.start), 'aria-label': `Select ${s.label}`, onchange: (e) => { if (e.target.checked) st.sel.add(s.start); else st.sel.delete(s.start); paintSegs(true); draw(); } });
      const play = h('button', { class: 'btn small rc-play' + (playing ? ' on' : ''), type: 'button', 'aria-label': playing ? 'Stop' : 'Play this segment', title: playing ? 'Stop' : 'Play this segment', onclick: () => (playing ? stopPlay() : playSeg(s)) }, playing ? '■' : '▶');
      let name;
      if (s.implicit) name = h('span', { class: 'rc-mname muted' }, s.label);
      else {
        name = h('input', { class: 'inline rc-mname', value: s.label, maxlength: 80, 'aria-label': 'Timestamp name' });
        name.onchange = () => saveMarks(engine.s.markers.map((m) => (m === s.marker ? { ...m, label: name.value.trim() || 'Timestamp' } : m)));
      }
      const pub = h('button', { class: 'btn small', type: 'button', disabled: len < 1 || st.busy, onclick: () => { if (st.open === s.start) st.fields.delete(`seg:${s.start}`); st.open = st.open === s.start ? null : s.start; paintSegs(true); } }, 'Publish');
      const del = s.implicit ? h('span', { class: 'rc-delgap' }) : h('button', { class: 'lnk', type: 'button', title: 'Delete this timestamp (the segment joins the one before it)', 'aria-label': 'Delete timestamp', onclick: () => saveMarks(engine.s.markers.filter((m) => m !== s.marker)) }, '✕');
      const row = h('div', { class: 'rc-seg' + (playing ? ' playing' : '') },
        h('div', { class: 'row rc-segrow' }, tick, play,
          h('div', { class: 'rc-segt' }, h('b', {}, clock(s.start)), h('span', { class: 'muted small' }, ` – ${clock(s.end)} · ${clock(len)}`)),
          h('div', { class: 'grow' }, name), pub, del));
      if (st.open === s.start) {
        const f = formFor({ key: `seg:${s.start}`, value: segTitle(s), label: 'Publish', onGo: (t, tf) => publishRanges(t, [[s.start, s.end]], 'Segment', tf), onCancel: () => { st.open = null; paintSegs(true); } });
        row.append(f.el);
        setTimeout(() => { f.input.focus(); f.input.select(); }, 0);
      }
      return row;
    });
    segsBox.replaceChildren(...(rows.length ? rows : [h('p', { class: 'small muted' }, 'No segments yet.')]));
    paintJoin(segs);
  }

  // Join: two or more ticked segments become one new post, in the order they appear in the recording.
  function paintJoin(segs) {
    const picked = segs.filter((s) => st.sel.has(s.start));
    joinBar.hidden = picked.length < 2;
    if (picked.length < 2) { st.joinEdited = false; return; }
    const auto = `${liveTitle()} · ${picked.map((s) => s.label).join(' + ')}`;
    const rec = fieldFor('join', auto);
    if (!st.joinEdited && rec.title !== auto) { rec.title = auto; rec.tf.refresh(); }
    const input = h('input', { value: rec.title, maxlength: 120, 'aria-label': 'Title for the joined post' });
    let t = 0;
    input.oninput = () => { rec.title = input.value; st.joinEdited = true; clearTimeout(t); t = setTimeout(() => rec.tf.refresh(), 400); };
    const go = h('button', { class: 'btn primary small', type: 'button', disabled: st.busy }, `Join & publish (${picked.length})`);
    const clear = () => { st.sel.clear(); st.joinEdited = false; st.fields.delete('join'); paintSegs(true); draw(); };
    go.onclick = async () => {
      go.disabled = true;
      const ok = await publishRanges(rec.title, picked.map((s) => [s.start, s.end]), 'Joined clip', rec.tf);
      if (ok) clear(); else { paintSegs(true); draw(); }
    };
    joinBar.replaceChildren(h('div', { class: 'small muted' }, `Joined in recording order, no re-encoding. There may be a faint click where two parts meet.`),
      h('div', { class: 'row rc-formrow' }, h('div', { class: 'grow' }, input), go, h('button', { class: 'btn small', type: 'button', onclick: clear }, 'Clear')), rec.tf.el);
  }

  /* ----- posts made from this recap ----- */
  const clipsBox = h('div', { class: 'rc-clips' });
  const clipsSum = h('summary', {}, 'Published from this recap');
  const clipsWrap = h('details', { class: 'rc-done' }, clipsSum, clipsBox);
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
    clipsSum.textContent = `Published from this recap (${rows.length})`;
    clipsBox.replaceChildren(...(rows.length ? rows.map((r) => {
      const s = stateOf(r);
      return h('div', { class: 'rc-clipitem' }, h('span', { class: 'grow' }, r.title), h('span', { class: 'small muted' }, clock(r.duration || 0)),
        h('span', { class: 'small ' + (s.startsWith('Failed') ? 'error' : s === 'Published' ? '' : 'muted') }, s),
        s === 'Draft' || s.startsWith('Failed') ? h('button', { class: 'lnk', type: 'button', onclick: () => { publishItemNow(r.id, r.title).then(() => paintClips(true), () => paintClips(true)); paintClips(true); } }, 'Retry') : null);
    }) : [h('p', { class: 'small muted' }, 'Nothing yet.')]));
  }
  const offJobs = onPublishJobs(() => paintClips());

  /* ----- the right side: Chats | Viewers, read only ----- */
  const tabChats = h('button', { class: 'tab on', type: 'button' }, 'Chats');
  const tabViewers = h('button', { class: 'tab', type: 'button' }, 'Viewers');
  const panelBody = h('div', { class: 'rc-panelbody' });
  const side = h('div', { class: 'rc-right' }, h('div', { class: 'row c-tabs' }, tabChats, tabViewers), panelBody);
  const openTab = (t) => { st.tab = t; tabChats.classList.toggle('on', t === 'chats'); tabViewers.classList.toggle('on', t === 'viewers'); st.panelKey = ''; paintPanel(); };
  tabChats.onclick = () => openTab('chats'); tabViewers.onclick = () => openTab('viewers');

  const stamp = (at, startedAt) => (startedAt && at ? clock((at - startedAt) / 1000) : at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–');

  function paintPanel() {
    const d = st.saved;
    const key = `${st.tab}|${d ? d.chat.length + ':' + d.viewers.length + ':' + d.viewersSaved : 'x'}|${engine.s.chat.length}`;
    if (key === st.panelKey) return;
    st.panelKey = key;
    if (!d) return panelBody.replaceChildren(h('p', { class: 'small muted' }, st.loading ? 'Loading what was saved…' : 'The saved chat and viewers need internet.'));
    if (st.tab === 'chats') {
      let lines = d.chat; let from = '';
      if (!lines.length && engine.s.chat.length) { lines = engine.s.chat.map((c) => ({ id: c.id, name: c.name, text: c.text, at: c.at, host: !!c.host })); from = 'Showing what the live room still holds. Nothing was saved for this live.'; }
      if (!lines.length) return panelBody.replaceChildren(h('p', { class: 'small muted' }, d.haveChat ? 'Nobody wrote in the chat during this live.' : 'The saved chat could not be loaded.'));
      const feed = h('div', { class: 'rc-chat', role: 'log' }, ...lines.map((c) => h('div', { class: 'cline' }, h('span', { class: 'muted rc-ct' }, stamp(c.at, d.startedAt)), ' ', c.host ? h('b', { class: 'host' }, c.name) : h('b', {}, c.name), ' ', h('span', {}, c.text))));
      panelBody.replaceChildren(...(from ? [h('p', { class: 'small muted' }, from)] : []), feed);
      return;
    }
    const people = d.viewers;
    const sum = d.total != null ? `${d.total} joined · ${people.length} with a name · ${d.guests || 0} guest${d.guests === 1 ? '' : 's'}` : `${people.length} with a name${d.guests ? ` · ${d.guests} guest${d.guests === 1 ? '' : 's'}` : ''}`;
    const rows = people.length ? people.map((v) => h('div', { class: 'rc-vrow' }, h('span', { class: 'grow rc-vname' }, v.name, h('span', { class: 'muted' }, v.uid8 ? ` ·${v.uid8}` : '')), h('span', { class: 'muted small rc-vc' }, v.joinedAt ? stamp(v.joinedAt, d.startedAt) : '–'), h('span', { class: 'small rc-vc' }, String(v.messages)), h('span', { class: 'small rc-vc rc-lv' }, String(v.love))))
      : [h('p', { class: 'small muted' }, 'No named viewers.')];
    panelBody.replaceChildren(
      h('p', { class: 'small muted' }, sum),
      !d.viewersSaved ? h('p', { class: 'small muted' }, 'Join times were not saved for this live, so only people who wrote or sent Love are shown. Lives that end from now on save the full list.') : null,
      people.length ? h('div', { class: 'rc-vrow rc-vhead small muted' }, h('span', { class: 'grow' }, 'Name'), h('span', { class: 'rc-vc' }, 'Joined'), h('span', { class: 'rc-vc' }, 'Msgs'), h('span', { class: 'rc-vc' }, 'Love')) : null,
      h('div', { class: 'rc-vlist' }, ...rows));
  }

  async function refreshSaved(force) {
    if (st.loading || !navigator.onLine) return;
    if (!force && Date.now() - st.savedAt < 30000) return;
    st.loading = true; st.savedAt = Date.now();
    try { st.saved = await loadSaved(itemId, hostName()); } catch { /* keep the last */ }
    st.loading = false;
    const d = st.saved;
    if (d) { sViews.v.textContent = d.views == null ? '–' : String(d.views); sPeak.v.textContent = d.peak == null ? '–' : String(d.peak); sLove.v.textContent = d.love == null ? '–' : String(d.love); }
    st.panelKey = ''; paintPanel();
  }

  /* ----- state: is the recording ready ----- */
  let lastCheck = 0;
  async function checkState(force) {
    if (!force && Date.now() - lastCheck < 15000) return;
    lastCheck = Date.now();
    try { st.published = await opts.published(); } catch { /* keep the last answer */ }
    const fresh = cap ? await db.captures.get(cap.id) : null;
    st.uploaded = !!(fresh && fresh.status === 'done' && !fresh.blobPending);
    note.textContent = !cap ? 'No recording was made on this device for this live.'
      : `${st.uploaded ? 'Saved to your private storage' : fresh?.status !== 'done' ? 'Finishing the recording…' : 'Uploading to your private storage. Keep the app open and online.'} · ${clock(total)} long${st.published ? ' · The replay of this live was already published the old way and is still online.' : ''}`;
    whole.disabled = !st.blob;
  }

  const el = h('section', { class: 'card c-recap' }, head, wholeForm,
    h('div', { class: 'rc-main' },
      h('div', { class: 'rc-left' }, wave,
        h('div', { class: 'row rc-listhead' }, h('h4', {}, 'Segments'), h('span', { class: 'grow' }), addMark),
        segsBox, joinBar, msg, clipsWrap),
      side));

  function paint() { checkState(false); paintSegs(); paintClips(); refreshSaved(false); paintPanel(); }

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
  if (!st.blob) { whole.disabled = true; msg.textContent = 'The recording is not on this device yet.'; }
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  paintSegs(true); await paintClips(true); await checkState(true);
  refreshSaved(true);
  setTimeout(draw, 30);
  return { el, paint, dispose() { dead = true; cancelAnimationFrame(raf); offJobs(); window.removeEventListener('resize', onResize); if (audio) { audio.pause(); audio = null; } if (url) URL.revokeObjectURL(url); } };
}
