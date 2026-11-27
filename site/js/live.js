// The public live page: countdown, listen, chat, requests, Love. The room (a Cloudflare Durable Object)
// carries everything that is live; Supabase carries what is kept (title, counters, reactions, saved chat).
import { h, fmtWhen, toast } from '../shared/dom.js';
import { connectRoom } from '../shared/live-socket.js';
import { pullAudio, watchQuality } from '../shared/sfu.js';
import { initAuth, mountAccountChip, getSession, onAuth, requireAuth, isMember } from './auth-ui.js';
import * as data from './data.js';
import { liveVideo } from './youtube-embed.js';

const svg = (d) => { const s = h('span'); s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`; return s.firstChild; };
const LOVE = '<path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>';
const PAUSE = '<path d="M6 5m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z"/><path d="M14 5m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z"/>';
const PLAY = '<path d="M7 4v16l13 -8z"/>';
const VOL = '<path d="M15 8a5 5 0 0 1 0 8"/><path d="M17.7 5a9 9 0 0 1 0 14"/><path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"/>';
const MUTE = '<path d="M15 8a5 5 0 0 1 1.912 4.934m-1.377 2.602a5 5 0 0 1 -.535 .464"/><path d="M17.7 5a9 9 0 0 1 2.362 11.086m-1.676 2.299a9 9 0 0 1 -.686 .615"/><path d="M9.069 5.054l.431 -.554a.8 .8 0 0 1 1.5 .5v2m0 4v8a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l1.294 -1.664"/><path d="M3 3l18 18"/>';
const EYE = '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>';
const SEND = '<path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/>';
const LIKE = '<path d="M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 2 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"/>';
const COMMENT = '<path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1"/>';
const SHARE = '<path d="M6 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M18 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M8.7 10.7l6.6 -3.4"/><path d="M8.7 13.3l6.6 3.4"/>';
const CHEV = '<path d="M6 9l6 6l6 -6"/>';
const id = new URLSearchParams(location.search).get('id') || '';
const root = document.getElementById('live');
const token = async () => (isMember() ? getSession().access_token : null);   // no guest accounts: no sign-in, no token
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const hh = Math.floor(s / 3600); return `${hh ? hh + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

const ERR = {
  'chat-off': 'Chat is off for this live.', 'chat-closed': 'Chat opens when the live starts.', 'chat-paused': 'Chat is paused for a moment.',
  'chat-muted': 'You cannot write in this chat.', 'chat-login': 'Sign in to write in the chat.',
  'request-login': 'Sign in to send requests.', 'request-closed': 'Requests open when the live starts.',
  'request-limit': 'You have enough open requests. Wait for one to be read.', slow: 'Slow mode is on. Wait a little before the next message.', rate: 'Too fast. Slow down a little.',
  login: 'This live is for signed-in accounts.', ended: 'This live has ended.',
};

async function main() {
  mountAccountChip(document.getElementById('account'), { newTab: true });
  await initAuth();
  let row = null;
  try { row = id ? await data.getLive(id) : null; } catch (e) { root.replaceChildren(h('p', { class: 'empty' }, 'Could not load this live. ' + data.friendly(e))); return; }
  if (!row) { root.replaceChildren(h('p', { class: 'empty' }, 'This live is not available.'), h('p', {}, h('a', { href: '/' }, 'Back to all poems'))); return; }
  document.title = `${row.title} | Fabris Poet`;
  let counted = false;
  const countView = () => { const s = getSession(); if (counted || !s || s.user.is_anonymous) return; counted = true; data.recordView(id, s.user.id); };
  countView();
  onAuth(countView);

  const S = {
    row, room: null, chat: [], listening: false, mine: new Set(), conn: 'connecting', q: null, pull: null, stopQ: null, epoch: -1, muted: false, meter: null, raf: 0,
    skew: 0,                       // server clock minus this phone's clock
    stopped: false, blocked: false, failedAt: 0,   // listening: stopped by the person / browser blocked autoplay / last failure
    poems: [], show: { on: false, poem: '', playing: '' },
    loveTotal: null, loves: [], seq: 0, pending: 0, loveTimer: null,
    reqMode: false, menu: false,
  };
  const status = () => S.room?.status || row.state;

  /* ----- pieces ----- */
  const badge = h('span', { class: 'l-badge' });
  const clockEl = h('b', { class: 'l-clock' });
  const watchEl = h('span', { class: 'l-meta l-watch' });
  // Under ● LIVE: pause / play. Under the watching count: mute / unmute. Line icons, no text.
  const playBtn = h('button', { class: 'l-ctl', type: 'button', hidden: true });
  const muteBtn = h('button', { class: 'l-ctl', type: 'button', hidden: true });
  const bars = h('div', { class: 'l-bars', 'aria-hidden': 'true' }, Array.from({ length: 14 }, () => h('b')));   // moved by the real sound level (see startMeter)
  const cardTop = h('div', { class: 'l-cardtop2' },
    h('div', { class: 'l-ctop-left' }, h('div', { class: 'l-row l-cardtop' }, badge, clockEl), playBtn),
    h('div', { class: 'l-ctop-right' }, watchEl, muteBtn));
  // the live title sits in the page header, centered; a long one slides instead of stretching the header
  // One line that slides back and forth when it is too long for the card (the page repaints every second, so these
  // elements are made once and only measured again when their text or width changes).
  const slideLine = (cls) => {
    const text = h('span', {});
    const box = h('div', { class: `${cls} l-slide` }, text);
    let now = null;
    const fit = () => {
      box.classList.remove('slide');
      const over = text.scrollWidth - box.clientWidth;
      if (over > 2) { box.style.setProperty('--d', over + 'px'); box.style.setProperty('--t', Math.max(6, (over / 25) * 2) + 's'); box.classList.add('slide'); }
    };
    if ('ResizeObserver' in window) new ResizeObserver(fit).observe(box);
    return { el: box, set(t) { if (t === now) return; now = t; text.textContent = t; box.title = t; requestAnimationFrame(fit); } };
  };
  // a music file name read as a title: no extension, underscores as spaces
  const tidyName = (n) => String(n || '').replace(/\.(mp3|m4a|aac|wav|ogg|opus|flac|webm|mp4)$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const poemLine = slideLine('l-poem'); const playLine = slideLine('l-play'); const thanksLine = slideLine('l-big');
  const titleBox = document.getElementById('liveTitle');
  const titleEl = document.getElementById('liveTitleText');
  let titleNow = null;
  const fitTitle = () => {
    titleBox.classList.remove('slide');
    const over = titleEl.scrollWidth - titleBox.clientWidth;
    if (over > 2) {
      titleBox.style.setProperty('--d', over + 'px');
      titleBox.style.setProperty('--t', Math.max(6, (over / 25) * 2) + 's');   // about 25px a second
      titleBox.classList.add('slide');
    }
  };
  const setTitle = (t) => { if (t === titleNow) return; titleNow = t; titleEl.textContent = t; titleBox.title = t; fitTitle(); };   // paint() runs every second: only measure when the text changed
  if ('ResizeObserver' in window) new ResizeObserver(fitTitle).observe(titleBox); else addEventListener('resize', fitTitle);
  document.fonts?.ready?.then(fitTitle);
  const stageImg = row.public_thumb_key ? h('img', { src: data.mediaUrl(row.public_thumb_key), alt: '' }) : null;
  const over = h('div', { class: 'l-over' });
  const stage = h('div', { class: 'l-stage' }, stageImg, h('div', { class: 'l-stagebody' }, cardTop, over));
  // The optional YouTube video. Opening it pauses this page's audio (so nothing plays twice); closing it lets the audio start again.
  const yt = liveVideo({ stage, onOpen: () => { S.stopped = true; stopListen(); paint(); }, onClose: () => { S.stopped = false; paint(); } });
  const audio = h('audio', { autoplay: true, playsinline: true });
  audio.hidden = true;
  const note = h('div', { class: 'l-note', hidden: true });
  const before = h('p', { class: 'l-meta', hidden: true }, 'Chat and requests open when the live starts.');

  // pills: views, love (a count), and the Request list
  const viewsPill = h('span', { class: 'l-pill' }, svg(EYE), h('b', { class: 'n' }));
  const lovePill = h('span', { class: 'l-pill love' }, svg(LOVE), h('b', { class: 'n' }));
  // Share: opens the phone's share sheet (or copies the link). The link carries this person's short id, so the host can see who brought whom in.
  const shareBtn = h('button', { class: 'l-pill', type: 'button', 'aria-label': 'Share this live' }, svg(SHARE), h('span', {}, 'Share'));
  const reqBtn = h('button', { class: 'l-pill req', type: 'button', 'aria-haspopup': 'listbox' }, h('span', {}, 'Request'), svg(CHEV));
  // the Request list: the first six poems show, the rest are reached by scrolling the list; "Other poem…" stays pinned under it
  const reqList = h('div', { class: 'l-menulist' });
  const reqOther = h('button', { type: 'button', role: 'option', class: 'other', onclick: () => { S.reqMode = true; S.menu = false; paint(); chatIn.focus(); } }, 'Other poem…');
  const reqMenu = h('div', { class: 'l-menu', role: 'listbox', hidden: true }, reqList, reqOther);
  const pills = h('div', { class: 'l-pills' }, viewsPill, lovePill, shareBtn, yt.btn, h('span', { class: 'grow' }), h('span', { class: 'l-reqwrap' }, reqBtn, reqMenu));

  const feed = h('div', { class: 'l-feed', role: 'log', 'aria-live': 'polite' });

  const gate = h('div', { class: 'l-panel l-gate', hidden: true });

  // the message box, docked at the bottom and lifted above the keyboard
  const chatIn = h('input', { placeholder: 'Write a message', maxlength: 300, 'aria-label': 'Message' });
  const loveBtn = h('button', { class: 'l-round love', type: 'button', 'aria-label': 'Send love' }, svg(LOVE));
  const sendBtn = h('button', { class: 'l-round go', type: 'button', 'aria-label': 'Send' }, svg(SEND));
  const modeChip = h('button', { class: 'l-mode', type: 'button', hidden: true, onclick: () => { S.reqMode = false; paint(); } }, 'Request ✕');
  const bubbles = h('div', { class: 'l-bubbles', 'aria-hidden': 'true' });
  const dock = h('div', { class: 'l-dock', hidden: true }, bubbles, h('div', { class: 'l-dockin' }, loveBtn, h('div', { class: 'l-box' }, modeChip, chatIn), sendBtn));

  root.replaceChildren(stage, yt.box, audio, before, pills, gate, note, feed);
  document.body.append(dock);

  const els = { q: h('div', { class: 'l-q-ind' }) };
  let feedKey = ''; let menuKey = '';
  const vv = window.visualViewport;
  const placeDock = () => {
    dock.style.setProperty('--kb', (vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0) + 'px');
    document.body.style.setProperty('--dock-h', dock.hidden ? '0px' : dock.offsetHeight + 'px');
  };
  vv?.addEventListener('resize', placeDock); vv?.addEventListener('scroll', placeDock);

  /* ----- room ----- */
  const room = connectRoom({
    item: id, getToken: token, ref: new URLSearchParams(location.search).get('ref') || '',
    onStatus: (c) => { S.conn = c; paint(); },
    onMessage: (m) => {
      if (m.t === 'state') {
        const was = status(); S.room = m; if (m.status !== was) refreshRow();
        if (typeof m.now === 'number') S.skew = m.now - Date.now();
        if (typeof m.loveTotal === 'number') S.loveTotal = Math.max(S.loveTotal || 0, m.loveTotal);
        onAudioEpoch();
      }
      else if (m.t === 'history') {
        S.chat = (m.chat || []).map((c) => ({ ...c, kind: 'chat' }));
        S.loves = (m.love || []).map((l) => ({ kind: 'love', uid8: l.uid8, name: l.name, total: l.total, at: l.at, seq: ++S.seq }));
      }
      else if (m.t === 'chat') S.chat = [...S.chat, { ...m.msg, kind: 'chat' }].slice(-200);
      else if (m.t === 'chatDel') S.chat = S.chat.filter((c) => c.id !== m.id);
      else if (m.t === 'count') { if (S.room) S.room.watching = m.watching; }
      else if (m.t === 'love') onLove(m);
      else if (m.t === 'thanks') toast(`Thank you for inviting ${m.name || 'a friend'}. They just joined through your link.`);
      else if (m.t === 'poems') S.poems = Array.isArray(m.titles) ? m.titles : [];
      else if (m.t === 'show') S.show = { on: !!m.on, poem: m.poem || '', playing: m.playing || '' };
      else if (m.t === 'err') { if (ERR[m.code]) toast(m.code === 'slow' && m.wait ? `Slow mode: wait ${m.wait}s.` : ERR[m.code]); }
      else if (m.t === 'ok') toast('Request sent.');
      paint();
    },
  });
  onAuth(() => { room.hello(); paint(); });

  async function refreshRow() { try { const r = await data.getLive(id); if (r) { S.row = r; paint(); } } catch { /* keep the last */ } }
  setInterval(refreshRow, 20000);

  /* ----- listen: starts by itself on arrival, stops on leaving ----- */
  async function listen(quiet = false) {
    if (S.listening) return;
    S.listening = true; S.blocked = false; paint();
    try {
      S.pull = await pullAudio({ item: id, getToken: token, onStream: (st) => {
        audio.srcObject = st; audio.muted = S.muted; startMeter(st);
        Promise.resolve(audio.play()).then(() => { S.blocked = false; paint(); }).catch(() => { S.blocked = true; paint(); });  // the browser may need one tap
      } });
      S.stopQ = watchQuality(S.pull.pc, (q) => { S.q = q; paintQ(); reportQ(q); });
      S.pull.pc.addEventListener('connectionstatechange', () => { if (['failed', 'disconnected'].includes(S.pull?.pc.connectionState)) setTimeout(() => { if (S.listening && S.pull?.pc.connectionState !== 'connected') relisten(); }, 3000); });
    } catch (e) {
      S.listening = false; S.failedAt = Date.now();
      if (!quiet) toast(e.status === 403 ? 'Sign in to listen.' : e.status === 409 || e.status === 404 ? 'The host is not sending audio right now.' : 'Could not start the audio. Try again.');
    }
    paint();
  }
  // Tell the room how the audio is arriving (the host's console sums it up, without names): at once when it changes,
  // otherwise about every 10 seconds. "silent" means the sound has been flat zero for three readings in a row.
  let lastQ = ''; let lastQAt = 0; let flat = 0;
  function reportQ(q) {
    flat = q.level != null && q.level < 0.002 ? flat + 1 : 0;
    const silent = flat >= 3 ? 1 : 0;
    const key = q.quality + silent;
    if (key === lastQ && Date.now() - lastQAt < 10000) return;
    lastQ = key; lastQAt = Date.now();
    room.send({ t: 'qual', q: q.quality, s: silent });
  }
  function stopListen() { if (S.listening) { try { room.send({ t: 'qual', off: 1 }); } catch { /* the room is gone */ } } lastQ = ''; flat = 0; stopMeter(); S.blocked = false; S.stopQ?.(); S.stopQ = null; try { S.pull?.close(); } catch { /* closed */ } S.pull = null; audio.srcObject = null; S.listening = false; S.q = null; }
  async function relisten() { stopListen(); await listen(true); }
  function onAudioEpoch() {
    const a = S.room?.audio;
    if (!a) return;
    if (S.listening && a.online && a.epoch !== S.epoch && S.epoch !== -1) relisten();
    S.epoch = a.epoch;
  }
  addEventListener('pagehide', () => { stopListen(); });
  function paintQ() { const q = els.q; q.textContent = S.q ? { good: 'Audio: good', fair: 'Audio: some stutter', poor: 'Audio: poor connection', stalled: 'Audio: no data' }[S.q.quality] : ''; q.className = 'l-q-ind ' + (S.q?.quality || ''); }

  /* ----- Like is a toggle kept in the database; Love is a burst of taps carried by the room ----- */
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----- the bars follow the real sound: the incoming stream goes through an analyser (it is not wired to the speakers; the <audio> element plays it) ----- */
  function startMeter(stream) {
    stopMeter();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0.6;
      src.connect(an);
      const m = { ctx, src, an, buf: new Uint8Array(an.frequencyBinCount) };
      S.meter = m;
      ctx.resume?.().catch(() => {});
      const els2 = [...bars.children];
      const step = () => {
        if (S.meter !== m) return;
        an.getByteFrequencyData(m.buf);
        const n = els2.length;
        for (let i = 0; i < n; i++) {
          const lo = 1 + Math.floor((i * 44) / n); const hi = Math.max(lo + 1, 1 + Math.floor(((i + 1) * 44) / n));
          let sum = 0; for (let k = lo; k < hi; k++) sum += m.buf[k] || 0;
          els2[i].style.height = Math.max(8, Math.min(100, Math.round((sum / (hi - lo) / 170) * 100))) + '%';
        }
        S.raf = requestAnimationFrame(step);
      };
      if (!calm()) step();
    } catch { /* no analyser here: the bars just stay low */ }
  }
  function stopMeter() {
    cancelAnimationFrame(S.raf); S.raf = 0;
    const m = S.meter; S.meter = null;
    if (m) { try { m.src.disconnect(); m.ctx.close(); } catch { /* already closed */ } }
    [...bars.children].forEach((b) => { b.style.height = ''; });
  }

  /* ----- pause / play (under LIVE) and mute (under the watching count) ----- */
  // Pause really stops the stream and Play joins it again at the live edge (a paused live stream would only fall behind).
  playBtn.onclick = () => {
    if (S.listening && S.blocked) { audio.play().then(() => { S.blocked = false; S.meter?.ctx.resume?.(); paint(); }).catch(() => toast('The browser still blocks the sound.')); return; }
    if (S.listening) { S.stopped = true; stopListen(); paint(); return; }
    S.stopped = false; listen();
  };
  muteBtn.onclick = () => { S.muted = !S.muted; audio.muted = S.muted; paint(); };
  // Hearts rise above the box. Each tap shows at once; taps are sent to the room in small batches.
  function heart(n = 1) {
    if (calm()) return;
    for (let i = 0; i < Math.min(3, n); i++) {
      const e = h('span', { class: 'l-heart', style: `left:${4 + Math.random() * 44}px;animation-delay:${i * 90}ms` }, svg(LOVE));
      bubbles.append(e); setTimeout(() => e.remove(), 1900);
    }
  }
  function tapLove() {
    if ((S.room?.you || {}).react !== 'ok') return toast('Love is not open right now.');
    S.pending = Math.min(60, S.pending + 1);
    heart(1);
    S.loveTimer ||= setTimeout(flushLove, 400);
  }
  function flushLove() {
    S.loveTimer = null;
    if (!S.pending) return;
    const n = Math.min(12, S.pending);
    if (room.send({ t: 'love', n })) S.pending -= n;
    if (S.pending > 0) S.loveTimer = setTimeout(flushLove, 400);
  }
  loveBtn.onclick = tapLove;
  // The link to share. It keeps this person's short id, never anything private, so a friend's arrival can be credited to them.
  const shareUrl = () => {
    const u = new URL('/live/', location.origin);
    u.searchParams.set('id', id);
    const uid = (S.room?.you?.uid || '').replace(/-/g, '').slice(0, 8);
    if (/^[0-9a-f]{8}$/i.test(uid)) u.searchParams.set('ref', uid);
    return u.toString();
  };
  shareBtn.onclick = async () => {
    const t = S.room?.title || S.row.title;
    const url = shareUrl();
    let done = false;
    if (navigator.share) {
      try { await navigator.share({ title: t, text: `${t} is live now. Join me.`, url }); done = true; }
      catch (e) { if (e?.name !== 'AbortError') { try { await navigator.clipboard.writeText(url); toast('Link copied.'); done = true; } catch { toast(url); } } }
    } else {
      try { await navigator.clipboard.writeText(url); toast('Link copied.'); done = true; } catch { toast(url); }
    }
    if (done) room.send({ t: 'share' });
  };
  // One line per person for a burst: "♥ Amina ×5". Rapid bursts update the same line.
  function onLove(m) {
    S.loveTotal = Math.max(S.loveTotal || 0, m.all || 0);
    const at = Date.now() + S.skew;
    const last = S.loves[S.loves.length - 1];
    if (last && last.uid8 === m.uid8 && at - last.at < 2500) { last.total = m.total; last.at = at; last.seq = ++S.seq; }
    else S.loves = [...S.loves, { kind: 'love', uid8: m.uid8, name: m.name, total: m.total, at, seq: ++S.seq }].slice(-100);
    if (m.uid8 !== (S.room?.you?.uid || '').slice(0, 4)) heart(Math.min(3, m.n || 1));
  }

  /* ----- chat and requests (one message box) ----- */
  const sendMsg = () => {
    const t = chatIn.value.trim(); if (!t) return;
    const msg = S.reqMode ? { t: 'request', kind: 'request', text: t } : { t: 'chat', text: t };
    if (room.send(msg)) { chatIn.value = ''; S.reqMode = false; paint(); } else toast('Reconnecting. Try again in a moment.');
  };
  sendBtn.onclick = sendMsg; chatIn.onkeydown = (e) => { if (e.key === 'Enter') sendMsg(); };
  const askFor = (text) => { if (room.send({ t: 'request', kind: 'request', text })) { S.menu = false; paint(); } else toast('Reconnecting. Try again in a moment.'); };
  reqBtn.onclick = (e) => {
    e.stopPropagation();
    const can = (S.room?.you || {}).request;
    if (can && can !== 'ok') return toast(ERR[`request-${can}`] || 'Requests are not open right now.');
    S.menu = !S.menu; paint();
  };
  document.addEventListener('click', (e) => { if (S.menu && !reqMenu.contains(e.target)) { S.menu = false; paint(); } });

  /* ----- painting ----- */
  const countdownText = () => {
    const set = S.row.settings || {};
    if (!S.row.starts_at) return null;
    const left = Date.parse(S.row.starts_at) - Date.now();
    if (!set.countdownEnabled) return { plain: `Planned for ${fmtWhen(S.row.starts_at)}` };
    if (left > (set.countdownMinutes || 60) * 60000) return { plain: `Planned for ${fmtWhen(S.row.starts_at)}` };
    if (left > 0) return { clock: hms(left) };
    return { plain: 'Starting soon. Waiting for Fabris to go live.' };
  };

  function paint() {
    const st = status();
    const caps = S.room?.you || {};
    const blocked = caps.blocked === 'login' || !isMember();   // a live needs an account
    const settings = { ...(S.row.settings || {}), ...(S.room?.settings || {}) };
    const live = st === 'live';
    const ended = st === 'ended';
    const audioOn = !!S.room?.audio?.online;
    setTitle(S.room?.title || S.row.title);
    badge.textContent = live ? '● LIVE' : ended ? 'ENDED' : 'UPCOMING';
    badge.className = 'l-badge' + (live ? ' on' : '');

    // the card: while live, the running clock stands where the views count used to be
    const started = S.room?.startedAt;
    clockEl.textContent = live && started ? hms(Date.now() + S.skew - started) : '';
    watchEl.textContent = live && settings.showWatching !== false && typeof S.room?.watching === 'number' ? `${S.room.watching} watching` : '';
    stage.classList.toggle('is-live', live);
    if (blocked) over.replaceChildren();
    else if (ended) {
      thanksLine.set(`Thank you for listening to ${S.room?.title || S.row.title}`);
      over.replaceChildren(thanksLine.el, h('p', { class: 'l-meta' }, 'This live has ended. Join me for the next live.'));
    } else if (!live) {
      const c = countdownText();
      over.replaceChildren(...[
        c?.clock ? h('div', { class: 'l-count' }, c.clock) : null,
        S.row.starts_at ? h('p', {}, `Starts ${fmtWhen(S.row.starts_at)}`) : h('p', {}, c?.plain || 'The live has not started yet.'),
        c?.plain === 'Starting soon. Waiting for Fabris to go live.' ? h('p', { class: 'l-meta' }, c.plain) : null,
        h('p', { class: 'l-meta' }, 'This page opens the live by itself.')].filter(Boolean));
    } else {
      const kids = [];
      if (S.show.on && S.show.poem) { poemLine.set(S.show.poem); kids.push(poemLine.el); }
      if (S.show.on && S.show.playing) { playLine.set(`♪ Playing ${tidyName(S.show.playing)}`); kids.push(playLine.el); }
      if (S.listening && S.blocked) kids.push(h('p', { class: 'l-meta' }, 'Tap play to listen.'));
      else if (S.listening) kids.push(bars, h('p', { class: 'l-meta' }, audioOn ? '' : 'The host\'s audio is reconnecting…'));
      else kids.push(h('p', { class: 'l-meta' }, S.stopped ? 'Paused. Tap play to listen.' : audioOn ? 'Connecting the audio…' : 'The audio will start in a moment.'));
      if (S.listening) kids.push(h('div', { class: 'l-row l-listenrow' }, els.q));
      over.replaceChildren(...kids.filter(Boolean));
    }
    paintQ();
    // listening starts by itself when the audio is on, unless the person stopped it (a failed try waits a few seconds)
    if (live && audioOn && !blocked && !S.listening && !S.stopped && Date.now() - S.failedAt > 5000) listen(true);

    yt.paint({ live, blocked, settings, title: S.room?.title || S.row.title });

    // pills
    const showPills = live && !blocked;
    pills.hidden = !showPills;
    const showCounts = settings.showReactionCounts !== false;
    viewsPill.hidden = settings.showViewCount === false || S.row.n_views == null;
    viewsPill.querySelector('.n').textContent = String(S.row.n_views ?? 0);
    const reactOn = settings.reactionsEnabled !== false && S.row.reactions_enabled;
    lovePill.hidden = !reactOn;
    lovePill.querySelector('.n').textContent = showCounts ? String(Math.max(0, live ? (S.loveTotal ?? 0) : (S.row.n_love || 0))) : '';
    const askShown = live && settings.requestsEnabled !== false;
    shareBtn.hidden = false;
    reqBtn.hidden = !askShown;
    reqBtn.classList.toggle('open', S.menu);
    reqMenu.hidden = !(S.menu && askShown);
    const mk = '#' + S.poems.join('|');   // the '#' makes an empty list differ from the starting key, so "Other poem…" always gets drawn
    if (mk !== menuKey) {
      reqList.replaceChildren(...S.poems.map((t2) => h('button', { type: 'button', role: 'option', onclick: () => askFor(t2) }, t2)));
      reqList.hidden = !S.poems.length;
      menuKey = mk;
    }

    // pause / play and mute
    const showCtl = live && !blocked;
    playBtn.hidden = muteBtn.hidden = !showCtl;
    const playing = S.listening && !S.blocked;
    if (playBtn.dataset.k !== (playing ? 'pause' : 'play')) { playBtn.dataset.k = playing ? 'pause' : 'play'; playBtn.replaceChildren(svg(playing ? PAUSE : PLAY)); }
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play'); playBtn.title = playing ? 'Pause' : 'Play';
    playBtn.disabled = !S.listening && !audioOn;
    if (muteBtn.dataset.k !== (S.muted ? 'm' : 'v')) { muteBtn.dataset.k = S.muted ? 'm' : 'v'; muteBtn.replaceChildren(svg(S.muted ? MUTE : VOL)); }
    muteBtn.setAttribute('aria-label', S.muted ? 'Unmute' : 'Mute'); muteBtn.title = S.muted ? 'Unmute' : 'Mute';

    // gates and notes
    gate.hidden = !blocked;
    if (blocked) gate.replaceChildren(h('h2', {}, 'Sign in to join'), h('p', {}, 'Lives are for signed-in accounts. Sign in with Google or email to listen, chat and react.'), h('button', { class: 'l-btn', type: 'button', onclick: () => requireAuth('join') }, 'Sign in or create an account'));
    note.hidden = S.conn === 'open' || blocked;
    note.textContent = S.conn === 'open' ? '' : S.conn === 'reconnecting' ? 'Reconnecting to the live…' : 'Connecting to the live…';
    before.hidden = live || ended;

    // one feed: chat, requests and love, in time order
    const reqs = (S.room?.requests || []).filter((r) => r.status !== 'dismissed').map((r) => ({ kind: 'request', id: r.id, name: r.name, text: r.text, at: r.at || 0, mine: r.mine, seq: 0 }));
    const lines = [...S.chat.map((c) => ({ ...c, seq: 0 })), ...reqs, ...S.loves].sort((x, y) => (x.at - y.at) || (x.seq - y.seq));
    const showFeed = !blocked && live;
    feed.hidden = !showFeed;
    const fk = lines.map((l) => `${l.kind}${l.id || l.uid8}:${l.total || ''}:${l.at}`).join(',');
    if (fk !== feedKey) {
      const end = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
      feed.replaceChildren(...(lines.length ? lines.map((l) => (l.kind === 'love'
        ? h('div', { class: 'l-line love' }, svg(LOVE), ` ${l.name} ×${l.total}`)
        : h('div', { class: 'l-line' + (l.host ? ' host' : '') }, h('b', {}, l.name), ' ', l.text, l.kind === 'request' ? h('span', { class: 'l-rlabel' }, 'request') : null)))
        : [h('p', { class: 'l-meta' }, live ? 'Nothing yet. Say hello, or tap the heart.' : '')]));
      if (end) feed.scrollTop = feed.scrollHeight;
      feedKey = fk;
    }

    // the message box (never before the live starts, never after it ends)
    const chatOn = settings.chatEnabled !== false;
    const showDock = live && !blocked && (chatOn || settings.requestsEnabled !== false || reactOn);
    dock.hidden = !showDock;
    document.body.classList.toggle('has-dock', showDock);
    document.getElementById('live').classList.toggle('is-live', showDock);
    loveBtn.hidden = !reactOn;
    const cc = caps.chat || 'ok';
    const typing = S.reqMode ? caps.request === 'ok' : cc === 'ok';
    chatIn.disabled = sendBtn.disabled = !typing;
    modeChip.hidden = !S.reqMode;
    chatIn.placeholder = S.reqMode ? 'Which poem would you like to hear?' : ({ ok: 'Write a message', closed: 'Chat opens when the live starts', paused: 'Chat is paused', muted: 'You cannot write here', login: 'Sign in to write', off: 'Chat is off' }[cc] || 'Write a message');
    chatIn.maxLength = S.reqMode ? 200 : 300;
    placeDock();
    if (!live && S.listening) { stopListen(); }
  }

  paint();
  setInterval(() => { if (status() !== 'ended') paint(); }, 1000);
}
main();
