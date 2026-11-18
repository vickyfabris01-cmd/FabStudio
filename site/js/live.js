// The public live page: countdown, listen, chat, requests, reactions. The room (a Cloudflare Durable Object)
// carries everything that is live; Supabase carries what is kept (title, counters, reactions, saved chat).
import { h, fmtWhen, toast } from '../shared/dom.js';
import { connectRoom } from '../shared/live-socket.js';
import { pullAudio, watchQuality } from '../shared/sfu.js';
import { initAuth, mountAccountChip, getSession, onAuth, requireAuth, guestReady } from './auth-ui.js';
import * as data from './data.js';

const svg = (d) => { const s = h('span'); s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`; return s.firstChild; };
const LOVE = '<path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>';
const LIKE = '<path d="M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 2 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"/>';
const EYE = '<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>';
const SEND = '<path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/>';
const CHEV = '<path d="M6 9l6 6l6 -6"/>';
const id = new URLSearchParams(location.search).get('id') || '';
const root = document.getElementById('live');
const token = async () => { const s = getSession() || await guestReady(); return s?.access_token || null; };
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const hh = Math.floor(s / 3600); return `${hh ? hh + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

const ERR = {
  'chat-off': 'Chat is off for this live.', 'chat-closed': 'Chat opens when the live starts.', 'chat-paused': 'Chat is paused for a moment.',
  'chat-muted': 'You cannot write in this chat.', 'chat-login': 'Sign in to write in the chat.',
  'request-login': 'Sign in to send requests.', 'request-closed': 'Requests open when the live starts.',
  'request-limit': 'You have enough open requests. Wait for one to be read.', slow: 'Slow mode is on. Wait a little before the next message.', rate: 'Too fast. Slow down a little.',
  login: 'This live is for signed-in accounts.', ended: 'This live has ended.',
};

async function main() {
  mountAccountChip(document.getElementById('account'));
  await initAuth({ guest: true });
  let row = null;
  try { row = id ? await data.getLive(id) : null; } catch (e) { root.replaceChildren(h('p', { class: 'empty' }, 'Could not load this live. ' + data.friendly(e))); return; }
  if (!row) { root.replaceChildren(h('p', { class: 'empty' }, 'This live is not available.'), h('p', {}, h('a', { href: '/' }, 'Back to all poems'))); return; }
  document.title = `${row.title} | Fabris Poet`;
  guestReady().then((s) => { if (s) data.recordView(id, s.user.id); });

  const S = {
    row, room: null, chat: [], listening: false, mine: new Set(), conn: 'connecting', q: null, pull: null, stopQ: null, epoch: -1,
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
  const cardTop = h('div', { class: 'l-row l-cardtop' }, badge, clockEl, h('span', { class: 'grow' }), watchEl);
  const title = h('h1');
  const stageImg = row.public_thumb_key ? h('img', { src: data.mediaUrl(row.public_thumb_key), alt: '' }) : null;
  const over = h('div', { class: 'l-over' });
  const stage = h('div', { class: 'l-stage' }, stageImg, h('div', { class: 'l-stagebody' }, cardTop, over));
  const audio = h('audio', { autoplay: true, playsinline: true });
  audio.hidden = true;
  const note = h('div', { class: 'l-note', hidden: true });
  const before = h('p', { class: 'l-meta', hidden: true }, 'Chat and requests open when the live starts.');

  // pills: views, love (a count), like (a toggle), and the Request list
  const viewsPill = h('span', { class: 'l-pill' }, svg(EYE), h('b', { class: 'n' }));
  const lovePill = h('span', { class: 'l-pill love' }, svg(LOVE), h('b', { class: 'n' }));
  const likeBtn = h('button', { class: 'l-pill', type: 'button', 'aria-label': 'Like' }, svg(LIKE), h('b', { class: 'n' }));
  const reqBtn = h('button', { class: 'l-pill req', type: 'button', 'aria-haspopup': 'listbox' }, h('span', {}, 'Request'), svg(CHEV));
  const reqMenu = h('div', { class: 'l-menu', role: 'listbox', hidden: true });
  const pills = h('div', { class: 'l-pills' }, viewsPill, lovePill, likeBtn, h('span', { class: 'grow' }), h('span', { class: 'l-reqwrap' }, reqBtn, reqMenu));
  const counts = { like: row.n_like || 0 };

  const feed = h('div', { class: 'l-feed', role: 'log', 'aria-live': 'polite' });

  // after the live: the counts, and two published poems to listen to while the recap is being prepared
  const stats = h('div', { class: 'l-stats', hidden: true });
  const waitBox = h('div', { class: 'l-wait', hidden: true });
  const wait = { items: null, loading: false, audio: null, playing: null, key: '' };
  async function loadWait() {
    if (wait.items || wait.loading) return;
    wait.loading = true;
    try {
      const all = (await data.listItems()).filter((x) => x.id !== id && x.public_media_key);
      for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
      wait.items = all.slice(0, 2);
    } catch { wait.items = []; }
    wait.loading = false; paint();
  }
  function playWait(it) {
    if (wait.playing === it.id) { wait.audio?.pause(); wait.playing = null; return paint(); }
    wait.audio?.pause();
    const a = new Audio(data.mediaUrl(it.public_media_key));
    a.ontimeupdate = () => { const bar = waitBox.querySelector(`[data-bar="${it.id}"]`); if (bar && a.duration) bar.style.width = `${Math.min(100, (a.currentTime / a.duration) * 100)}%`; };
    a.onended = () => { wait.playing = null; paint(); };
    a.play().then(() => { wait.audio = a; wait.playing = it.id; paint(); }).catch(() => toast('Could not play this one.'));
  }
  const gate = h('div', { class: 'l-panel l-gate', hidden: true });

  // the message box, docked at the bottom and lifted above the keyboard
  const chatIn = h('input', { placeholder: 'Write a message', maxlength: 300, 'aria-label': 'Message' });
  const loveBtn = h('button', { class: 'l-round love', type: 'button', 'aria-label': 'Send love' }, svg(LOVE));
  const sendBtn = h('button', { class: 'l-round go', type: 'button', 'aria-label': 'Send' }, svg(SEND));
  const modeChip = h('button', { class: 'l-mode', type: 'button', hidden: true, onclick: () => { S.reqMode = false; paint(); } }, 'Request ✕');
  const bubbles = h('div', { class: 'l-bubbles', 'aria-hidden': 'true' });
  const dock = h('div', { class: 'l-dock', hidden: true }, bubbles, h('div', { class: 'l-dockin' }, loveBtn, h('div', { class: 'l-box' }, modeChip, chatIn), sendBtn));

  root.replaceChildren(stage, audio, title, before, pills, gate, note, feed, waitBox, stats);
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
    item: id, getToken: token,
    onStatus: (c) => { S.conn = c; paint(); },
    onMessage: (m) => {
      if (m.t === 'state') {
        const was = status(); S.room = m; if (m.status !== was) refreshRow();
        if (typeof m.now === 'number') S.skew = m.now - Date.now();
        if (typeof m.loveTotal === 'number') S.loveTotal = Math.max(S.loveTotal || 0, m.loveTotal);
        onAudioEpoch();
      }
      else if (m.t === 'history') S.chat = (m.chat || []).map((c) => ({ ...c, kind: 'chat' }));
      else if (m.t === 'chat') S.chat = [...S.chat, { ...m.msg, kind: 'chat' }].slice(-200);
      else if (m.t === 'chatDel') S.chat = S.chat.filter((c) => c.id !== m.id);
      else if (m.t === 'count') { if (S.room) S.room.watching = m.watching; }
      else if (m.t === 'react') { pops(m.like); }
      else if (m.t === 'love') onLove(m);
      else if (m.t === 'poems') S.poems = Array.isArray(m.titles) ? m.titles : [];
      else if (m.t === 'show') S.show = { on: !!m.on, poem: m.poem || '', playing: m.playing || '' };
      else if (m.t === 'err') { if (ERR[m.code]) toast(m.code === 'slow' && m.wait ? `Slow mode: wait ${m.wait}s.` : ERR[m.code]); }
      else if (m.t === 'ok') toast('Request sent.');
      paint();
    },
  });
  onAuth(() => { room.hello(); });

  async function refreshRow() { try { const r = await data.getLive(id); if (r) { S.row = r; paint(); } } catch { /* keep the last */ } }
  setInterval(refreshRow, 20000);

  /* ----- listen: starts by itself on arrival, stops on leaving ----- */
  async function listen(quiet = false) {
    if (S.listening) return;
    S.listening = true; S.blocked = false; paint();
    try {
      S.pull = await pullAudio({ item: id, getToken: token, onStream: (st) => {
        audio.srcObject = st;
        Promise.resolve(audio.play()).then(() => { S.blocked = false; paint(); }).catch(() => { S.blocked = true; paint(); });  // the browser may need one tap
      } });
      S.stopQ = watchQuality(S.pull.pc, (q) => { S.q = q; paintQ(); });
      S.pull.pc.addEventListener('connectionstatechange', () => { if (['failed', 'disconnected'].includes(S.pull?.pc.connectionState)) setTimeout(() => { if (S.listening && S.pull?.pc.connectionState !== 'connected') relisten(); }, 3000); });
    } catch (e) {
      S.listening = false; S.failedAt = Date.now();
      if (!quiet) toast(e.status === 403 ? 'Sign in to listen.' : e.status === 409 || e.status === 404 ? 'The host is not sending audio right now.' : 'Could not start the audio. Try again.');
    }
    paint();
  }
  function stopListen() { S.blocked = false; S.stopQ?.(); S.stopQ = null; try { S.pull?.close(); } catch { /* closed */ } S.pull = null; audio.srcObject = null; S.listening = false; S.q = null; }
  async function relisten() { stopListen(); await listen(true); }
  function onAudioEpoch() {
    const a = S.room?.audio;
    if (!a) return;
    if (S.listening && a.online && a.epoch !== S.epoch && S.epoch !== -1) relisten();
    S.epoch = a.epoch;
  }
  addEventListener('pagehide', () => { stopListen(); wait.audio?.pause(); });
  function paintQ() { const q = els.q; q.textContent = S.q ? { good: 'Audio: good', fair: 'Audio: some stutter', poor: 'Audio: poor connection', stalled: 'Audio: no data' }[S.q.quality] : ''; q.className = 'l-q-ind ' + (S.q?.quality || ''); }

  /* ----- Like is a toggle kept in the database; Love is a burst of taps carried by the room ----- */
  const mineLoaded = (async () => { const s2 = await guestReady(); if (s2) { try { (await data.myReactions(id, s2.user.id)).forEach((t) => S.mine.add(t)); paint(); } catch { /* ignore */ } } })();
  async function toggle(type) {
    const s2 = await requireAuth(); if (!s2) return;
    try {
      if (S.mine.has(type)) { await data.clearReaction(id, s2.user.id, type); S.mine.delete(type); counts[type] -= 1; }
      else { await data.setReaction(id, s2.user.id, type); S.mine.add(type); counts[type] += 1; room.send({ t: 'react', type }); }
      paint();
    } catch (e) { toast(data.friendly(e)); }
  }
  likeBtn.onclick = () => toggle('like');

  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function pops(like) {
    if (calm()) return;
    for (let i = 0; i < Math.min(4, like || 0); i++) {
      const e = h('span', { class: 'l-pop', style: `left:${10 + Math.random() * 80}%;bottom:8%` }, '👍');
      stage.append(e); setTimeout(() => e.remove(), 1700);
    }
  }
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
    const blocked = caps.blocked === 'login';
    const settings = { ...(S.row.settings || {}), ...(S.room?.settings || {}) };
    const live = st === 'live';
    const ended = st === 'ended';
    const audioOn = !!S.room?.audio?.online;
    title.textContent = S.room?.title || S.row.title;
    title.className = live ? 'l-evt' : '';
    badge.textContent = live ? '● LIVE' : ended ? 'ENDED' : 'UPCOMING';
    badge.className = 'l-badge' + (live ? ' on' : '');

    // the card: while live, the running clock stands where the views count used to be
    const started = S.room?.startedAt;
    clockEl.textContent = live && started ? hms(Date.now() + S.skew - started) : '';
    watchEl.textContent = live && settings.showWatching !== false && typeof S.room?.watching === 'number' ? `${S.room.watching} watching` : '';
    stage.classList.toggle('is-live', live);
    if (blocked) over.replaceChildren();
    else if (ended) {
      const ready = !!S.row.public_media_key;
      over.replaceChildren(...(ready
        ? [h('p', { class: 'l-big' }, 'This live has ended. The replay is ready.'), h('a', { class: 'l-btn', href: `/poem/?id=${id}` }, 'Watch the replay')]
        : [h('p', { class: 'l-big' }, 'Live recap will be available soon'), h('p', { class: 'l-meta' }, `Thanks for listening to ${S.room?.title || S.row.title}`)]));
    } else if (!live) {
      const c = countdownText();
      over.replaceChildren(...[
        c?.clock ? h('div', { class: 'l-count' }, c.clock) : null,
        S.row.starts_at ? h('p', {}, `Starts ${fmtWhen(S.row.starts_at)}`) : h('p', {}, c?.plain || 'The live has not started yet.'),
        c?.plain === 'Starting soon. Waiting for Fabris to go live.' ? h('p', { class: 'l-meta' }, c.plain) : null,
        h('p', { class: 'l-meta' }, 'This page opens the live by itself.')].filter(Boolean));
    } else {
      const kids = [];
      if (S.show.on && S.show.poem) kids.push(h('div', { class: 'l-poem' }, S.show.poem));
      if (S.show.on && S.show.playing) kids.push(h('div', { class: 'l-play' }, `♪ Playing ${S.show.playing}`));
      if (S.listening && S.blocked) {
        kids.push(h('button', { class: 'l-btn', type: 'button', onclick: () => audio.play().then(() => { S.blocked = false; paint(); }).catch(() => toast('The browser still blocks the sound.')) }, 'Tap to listen'));
      } else if (S.listening) {
        kids.push(h('div', { class: 'l-bars', 'aria-hidden': 'true' }, Array.from({ length: 14 }, () => h('b'))), h('p', { class: 'l-meta' }, audioOn ? '' : 'The host\'s audio is reconnecting…'));
      } else {
        kids.push(h('button', { class: 'l-btn', type: 'button', disabled: !audioOn, onclick: () => { S.stopped = false; listen(); } }, audioOn ? 'Listen live' : 'Starting…'));
        if (!audioOn) kids.push(h('p', { class: 'l-meta' }, 'The audio will start in a moment.'));
      }
      if (S.listening) kids.push(h('div', { class: 'l-row l-listenrow' }, els.q, h('button', { class: 'l-link', type: 'button', onclick: () => { S.stopped = true; stopListen(); paint(); } }, 'Stop listening')));
      over.replaceChildren(...kids.filter(Boolean));
    }
    paintQ();
    // listening starts by itself when the audio is on, unless the person stopped it (a failed try waits a few seconds)
    if (live && audioOn && !blocked && !S.listening && !S.stopped && Date.now() - S.failedAt > 5000) listen(true);

    // pills
    const showPills = live && !blocked;
    pills.hidden = !showPills;
    const showCounts = settings.showReactionCounts !== false;
    viewsPill.hidden = settings.showViewCount === false || S.row.n_views == null;
    viewsPill.querySelector('.n').textContent = String(S.row.n_views ?? 0);
    const reactOn = settings.reactionsEnabled !== false && S.row.reactions_enabled;
    lovePill.hidden = !reactOn;
    lovePill.querySelector('.n').textContent = showCounts ? String(Math.max(0, live ? (S.loveTotal ?? 0) : (S.row.n_love || 0))) : '';
    likeBtn.hidden = !reactOn;
    likeBtn.classList.toggle('on', S.mine.has('like'));
    likeBtn.querySelector('.n').textContent = showCounts ? String(Math.max(0, counts.like)) : '';
    const askShown = live && settings.requestsEnabled !== false;
    reqBtn.hidden = !askShown;
    reqBtn.classList.toggle('open', S.menu);
    reqMenu.hidden = !(S.menu && askShown);
    const mk = S.poems.join('|');
    if (mk !== menuKey) {
      reqMenu.replaceChildren(...S.poems.map((t2) => h('button', { type: 'button', role: 'option', onclick: () => askFor(t2) }, t2)),
        h('button', { type: 'button', role: 'option', class: 'other', onclick: () => { S.reqMode = true; S.menu = false; paint(); chatIn.focus(); } }, 'Other poem…'));
      menuKey = mk;
    }

    // gates and notes
    gate.hidden = !blocked;
    if (blocked) gate.replaceChildren(h('h2', {}, 'Sign in to join'), h('p', {}, 'This live is for signed-in accounts only.'), h('a', { class: 'l-btn', href: `/auth/?next=${encodeURIComponent(location.pathname + location.search)}` }, 'Sign in or create an account'));
    note.hidden = S.conn === 'open';
    note.textContent = S.conn === 'open' ? '' : S.conn === 'reconnecting' ? 'Reconnecting to the live…' : 'Connecting to the live…';
    before.hidden = live || ended || blocked;

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

    // after the live: counts, and (until the replay is published) two poems to listen to meanwhile
    const ready = ended && !!S.row.public_media_key;
    stats.hidden = !ended || blocked;
    if (ended) {
      stats.replaceChildren(h('span', { class: 'l-pill' }, svg(EYE), h('b', {}, String(S.row.n_views ?? 0))),
        h('span', { class: 'l-pill love' }, svg(LOVE), h('b', {}, String(S.row.n_love ?? 0))),
        h('span', { class: 'l-pill' }, svg(LIKE), h('b', {}, String(Math.max(0, counts.like)))),
        h('span', { class: 'grow' }), h('a', { class: 'l-link', href: '/' }, 'More poems'));
    }
    waitBox.hidden = !ended || ready || blocked;
    if (ended && !ready) {
      loadWait();
      const wk = (wait.items || []).map((x) => x.id).join() + '|' + wait.playing;
      if (wk !== wait.key) {
        wait.key = wk;
        waitBox.replaceChildren(...((wait.items || []).length ? [h('h2', {}, 'While you wait'), ...wait.items.map((it) => h('div', { class: 'l-witem' },
          h('button', { class: 'l-round', type: 'button', 'aria-label': wait.playing === it.id ? 'Pause' : 'Play', onclick: () => playWait(it) }, wait.playing === it.id ? '❚❚' : '▶'),
          h('div', { class: 'grow' }, h('div', { class: 'l-wtitle' }, it.title || 'Untitled'), h('div', { class: 'l-wbar' }, h('i', { 'data-bar': it.id }))),
          h('span', { class: 'l-meta' }, it.duration ? `${Math.floor(it.duration / 60)}:${String(Math.round(it.duration % 60)).padStart(2, '0')}` : '')))] : []));
      }
    } else if (wait.audio) { wait.audio.pause(); wait.audio = null; wait.playing = null; wait.key = ''; }

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
  await mineLoaded;
}
main();
