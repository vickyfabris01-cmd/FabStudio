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
const id = new URLSearchParams(location.search).get('id') || '';
const root = document.getElementById('live');
const token = async () => { const s = getSession() || await guestReady(); return s?.access_token || null; };
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const hh = Math.floor(s / 3600); return `${hh ? hh + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

const ERR = {
  'chat-off': 'Chat is off for this live.', 'chat-closed': 'Chat opens when the live starts.', 'chat-paused': 'Chat is paused for a moment.',
  'chat-muted': 'You cannot write in this chat.', 'chat-login': 'Sign in to write in the chat.',
  'request-login': 'Sign in to send requests.', 'question-login': 'Sign in to ask questions.', 'request-closed': 'Requests open when the live starts.', 'question-closed': 'Questions open when the live starts.',
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

  const S = { row, room: null, chat: [], listening: false, mine: new Set(), conn: 'connecting', q: null, pull: null, stopQ: null, epoch: -1 };
  const status = () => S.room?.status || row.state;

  /* ----- pieces ----- */
  const badge = h('span', { class: 'l-badge' });
  const title = h('h1');
  const meta = h('div', { class: 'l-meta' });
  const stageImg = row.public_thumb_key ? h('img', { src: data.mediaUrl(row.public_thumb_key), alt: '' }) : null;
  const over = h('div', { class: 'l-over' });
  const stage = h('div', { class: 'l-stage' }, stageImg, over);
  const audio = h('audio', { autoplay: true, playsinline: true });
  audio.hidden = true;
  const note = h('div', { class: 'l-note', hidden: true });

  const loveBtn = h('button', { type: 'button' }, svg(LOVE), h('span', {}, 'Love'), h('b', { class: 'n' }));
  const likeBtn = h('button', { type: 'button' }, svg(LIKE), h('span', {}, 'Like'), h('b', { class: 'n' }));
  const react = h('div', { class: 'l-react' }, loveBtn, likeBtn);
  const counts = { love: row.n_love || 0, like: row.n_like || 0 };

  const chatBox = h('div', { class: 'l-chat', role: 'log', 'aria-live': 'polite' });
  const pin = h('div', { class: 'l-note', hidden: true });
  const chatIn = h('input', { placeholder: 'Write a message', maxlength: 300, 'aria-label': 'Chat message' });
  const chatSend = h('button', { class: 'l-btn', type: 'button' }, 'Send');
  const chatPanel = h('section', { class: 'l-panel' }, h('h2', {}, 'Chat'), pin, chatBox, h('div', { class: 'l-form' }, chatIn, chatSend));

  const kind = h('select', { 'aria-label': 'Type' }, h('option', { value: 'request' }, 'Poem request'), h('option', { value: 'question' }, 'Question'));
  const reqIn = h('input', { placeholder: 'Which poem, or what would you ask?', maxlength: 200, 'aria-label': 'Your request' });
  const reqSend = h('button', { class: 'l-btn', type: 'button' }, 'Send');
  const reqList = h('div');
  const reqNote = h('p', { class: 'l-meta', hidden: true });
  const reqPanel = h('section', { class: 'l-panel' }, h('h2', {}, 'Requests and questions'), h('div', { class: 'l-form' }, kind, reqIn, reqSend), reqNote, reqList);
  const gate = h('div', { class: 'l-panel l-gate', hidden: true });

  root.replaceChildren(h('div', { class: 'l-row' }, badge, h('span', { class: 'grow' }), meta), title, stage, audio, note, react, gate, chatPanel, reqPanel);

  const els = { q: h('div', { class: 'l-q-ind' }) };
  let chatKey = ''; let reqKey = '';

  /* ----- room ----- */
  const room = connectRoom({
    item: id, getToken: token,
    onStatus: (c) => { S.conn = c; paint(); },
    onMessage: (m) => {
      if (m.t === 'state') { const was = status(); S.room = m; if (m.status !== was) refreshRow(); onAudioEpoch(); }
      else if (m.t === 'history') S.chat = m.chat || [];
      else if (m.t === 'chat') S.chat = [...S.chat, m.msg].slice(-200);
      else if (m.t === 'chatDel') S.chat = S.chat.filter((c) => c.id !== m.id);
      else if (m.t === 'count') { if (S.room) S.room.watching = m.watching; }
      else if (m.t === 'react') { pops(m.love, m.like); }
      else if (m.t === 'err') { if (ERR[m.code]) toast(m.code === 'slow' && m.wait ? `Slow mode: wait ${m.wait}s.` : ERR[m.code]); }
      else if (m.t === 'ok') toast(m.what === 'question' ? 'Question sent.' : 'Request sent.');
      paint();
    },
  });
  onAuth(() => { room.hello(); });

  async function refreshRow() { try { const r = await data.getLive(id); if (r) { S.row = r; paint(); } } catch { /* keep the last */ } }
  setInterval(refreshRow, 20000);

  /* ----- listen ----- */
  async function listen() {
    if (S.listening) return;
    S.listening = true; paint();
    try {
      S.pull = await pullAudio({ item: id, getToken: token, onStream: (st) => { audio.srcObject = st; audio.play().catch(() => {}); } });
      S.stopQ = watchQuality(S.pull.pc, (q) => { S.q = q; paintQ(); });
      S.pull.pc.addEventListener('connectionstatechange', () => { if (['failed', 'disconnected'].includes(S.pull?.pc.connectionState)) setTimeout(() => { if (S.listening && S.pull?.pc.connectionState !== 'connected') relisten(); }, 3000); });
    } catch (e) {
      S.listening = false;
      toast(e.status === 403 ? 'Sign in to listen.' : e.status === 409 || e.status === 404 ? 'The host is not sending audio right now.' : 'Could not start the audio. Try again.');
    }
    paint();
  }
  function stopListen() { S.stopQ?.(); S.stopQ = null; try { S.pull?.close(); } catch { /* closed */ } S.pull = null; audio.srcObject = null; S.listening = false; S.q = null; }
  async function relisten() { stopListen(); await listen(); }
  function onAudioEpoch() {
    const a = S.room?.audio;
    if (!a) return;
    if (S.listening && a.online && a.epoch !== S.epoch && S.epoch !== -1) relisten();
    S.epoch = a.epoch;
  }
  function paintQ() { const q = els.q; q.textContent = S.q ? { good: 'Audio: good', fair: 'Audio: some stutter', poor: 'Audio: poor connection', stalled: 'Audio: no data' }[S.q.quality] : ''; q.className = 'l-q-ind ' + (S.q?.quality || ''); }

  /* ----- reactions ----- */
  const mineLoaded = (async () => { const s = await guestReady(); if (s) { try { (await data.myReactions(id, s.user.id)).forEach((t) => S.mine.add(t)); paint(); } catch { /* ignore */ } } })();
  async function toggle(type) {
    const s = await requireAuth(); if (!s) return;
    try {
      if (S.mine.has(type)) { await data.clearReaction(id, s.user.id, type); S.mine.delete(type); counts[type] -= 1; }
      else { await data.setReaction(id, s.user.id, type); S.mine.add(type); counts[type] += 1; room.send({ t: 'react', type }); }
      paint();
    } catch (e) { toast(data.friendly(e)); }
  }
  loveBtn.onclick = () => toggle('love'); likeBtn.onclick = () => toggle('like');
  function pops(love, like) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const n = Math.min(6, (love || 0) + (like || 0));
    for (let i = 0; i < n; i++) {
      const e = h('span', { class: 'l-pop', style: `left:${10 + Math.random() * 80}%;bottom:8%` }, i < (love || 0) ? '♥' : '👍');
      stage.append(e); setTimeout(() => e.remove(), 1700);
    }
  }

  /* ----- chat and requests ----- */
  const sendChat = () => { const t = chatIn.value.trim(); if (!t) return; if (room.send({ t: 'chat', text: t })) chatIn.value = ''; else toast('Reconnecting. Try again in a moment.'); };
  chatSend.onclick = sendChat; chatIn.onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  const sendReq = () => { const t = reqIn.value.trim(); if (!t) return; if (room.send({ t: 'request', kind: kind.value, text: t })) reqIn.value = ''; else toast('Reconnecting. Try again in a moment.'); };
  reqSend.onclick = sendReq; reqIn.onkeydown = (e) => { if (e.key === 'Enter') sendReq(); };

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
    title.textContent = S.room?.title || S.row.title;
    badge.textContent = st === 'live' ? '● LIVE' : st === 'ended' ? 'ENDED' : 'UPCOMING';
    badge.className = 'l-badge' + (st === 'live' ? ' on' : '');
    const bits = [];
    if (settings.showViewCount && S.row.n_views != null) bits.push(`${S.row.n_views} view${S.row.n_views === 1 ? '' : 's'}`);
    if (settings.showWatching !== false && typeof S.room?.watching === 'number' && st === 'live') bits.push(`${S.room.watching} watching now`);
    meta.textContent = bits.join(' · ');

    // stage
    const live = st === 'live';
    const audioOn = !!S.room?.audio?.online;
    if (blocked) over.replaceChildren();
    else if (st === 'ended') {
      over.replaceChildren(h('p', {}, S.row.public_media_key ? 'This live has ended. The replay is ready.' : 'This live has ended.'),
        S.row.public_media_key ? h('a', { class: 'l-btn', href: `/poem/?id=${id}` }, 'Watch the replay') : h('a', { class: 'l-btn ghost', href: '/' }, 'More poems'));
    } else if (!live) {
      const c = countdownText();
      over.replaceChildren(...[c?.clock ? h('div', { class: 'l-count' }, c.clock) : null, h('p', {}, c?.plain || 'The live has not started yet.'), h('p', { class: 'l-meta' }, 'This page opens the live by itself when Fabris goes live.')].filter(Boolean));
    } else {
      over.replaceChildren(...(S.listening
        ? [h('div', { class: 'l-bars', 'aria-hidden': 'true' }, Array.from({ length: 14 }, () => h('b'))), h('p', {}, audioOn ? 'Listening' : 'The host\'s audio is reconnecting…'), els.q, h('button', { class: 'l-btn ghost', type: 'button', onclick: () => { stopListen(); paint(); } }, 'Stop listening')]
        : [h('button', { class: 'l-btn', type: 'button', disabled: !audioOn, onclick: listen }, audioOn ? 'Listen live' : 'Starting…'), !audioOn ? h('p', { class: 'l-meta' }, 'The audio will start in a moment.') : null].filter(Boolean)));
    }
    paintQ();

    // reactions
    const showReact = settings.reactionsEnabled !== false && S.row.reactions_enabled && !blocked;
    react.hidden = !showReact;
    loveBtn.classList.toggle('on', S.mine.has('love')); likeBtn.classList.toggle('on', S.mine.has('like'));
    const showCounts = settings.showReactionCounts !== false;
    loveBtn.querySelector('.n').textContent = showCounts ? String(Math.max(0, counts.love)) : '';
    likeBtn.querySelector('.n').textContent = showCounts ? String(Math.max(0, counts.like)) : '';

    // gates and notes
    gate.hidden = !blocked;
    if (blocked) gate.replaceChildren(h('h2', {}, 'Sign in to join'), h('p', {}, 'This live is for signed-in accounts only.'), h('a', { class: 'l-btn', href: `/auth/?next=${encodeURIComponent(location.pathname + location.search)}` }, 'Sign in or create an account'));
    note.hidden = S.conn === 'open';
    note.textContent = S.conn === 'open' ? '' : S.conn === 'reconnecting' ? 'Reconnecting to the live…' : 'Connecting to the live…';
    chatPanel.hidden = blocked || settings.chatEnabled === false || st === 'ended' && !S.chat.length;
    reqPanel.hidden = blocked || (settings.requestsEnabled === false && settings.questionsEnabled === false) || st === 'ended';

    // chat
    const ck = S.chat.length + ':' + (S.chat.at(-1)?.id || '');
    if (ck !== chatKey) {
      const end = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 60;
      chatBox.replaceChildren(...S.chat.map((c) => h('div', { class: c.host ? 'host' : '' }, h('b', {}, c.name), ' ', c.text)));
      if (end) chatBox.scrollTop = chatBox.scrollHeight;
      chatKey = ck;
    }
    const pinned = S.room?.pinned;
    pin.hidden = !pinned; if (pinned) pin.textContent = `📌 ${pinned.text}`;
    const cc = caps.chat || 'ok';
    const canChat = cc === 'ok';
    chatIn.disabled = chatSend.disabled = !canChat;
    chatIn.placeholder = { ok: 'Write a message', closed: 'Chat opens when the live starts', paused: 'Chat is paused', muted: 'You cannot write here', login: 'Sign in to write', off: 'Chat is off' }[cc] || 'Write a message';

    // requests
    const askOk = (caps.request === 'ok') || (caps.question === 'ok');
    reqIn.disabled = reqSend.disabled = kind.disabled = !askOk;
    kind.querySelector('[value=request]').disabled = caps.request !== 'ok'; kind.querySelector('[value=question]').disabled = caps.question !== 'ok';
    if (S.room && kind.selectedOptions[0]?.disabled) kind.value = caps.request === 'ok' ? 'request' : 'question';
    reqNote.hidden = askOk;
    reqNote.textContent = caps.request === 'login' || caps.question === 'login' ? 'Sign in to send requests.' : st !== 'live' ? 'Requests open when the live starts.' : '';
    const rk = JSON.stringify((S.room?.requests || []).map((r) => [r.id, r.status]));
    if (rk !== reqKey) {
      const list = (S.room?.requests || []).filter((r) => r.status !== 'dismissed');
      reqList.replaceChildren(...(list.length ? list.map((r) => h('div', { class: `l-req ${r.status === 'reading' ? 'now' : r.status === 'done' ? 'done' : ''} ${r.mine ? 'mine' : ''}` },
        h('span', { class: 'l-q' }, r.kind === 'question' ? 'question' : 'poem'), h('span', { class: 't' }, r.text), h('span', { class: 'l-meta' }, r.name))) : [h('p', { class: 'l-meta' }, settings.requestsVisible === false ? 'You will see your own requests here.' : 'No requests yet.')]));
      reqKey = rk;
    }
    if (!live && S.listening) { stopListen(); }
  }

  paint();
  setInterval(() => { if (status() === 'scheduled' || (status() !== 'live' && status() !== 'ended')) paint(); }, 1000);
  await mineLoaded;
}
main();
