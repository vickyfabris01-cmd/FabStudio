// The chat pane: tabs Chats | Requests. Chats shows everything in time order, newest at the bottom: chat messages,
// requests (with a small label after the text), joined lines and Love bursts. Requests is the queue you work
// through. Each tab's badge counts what arrived since that tab was last open. Pause chat and mute by ID are in
// the settings modal; pin is not offered here.
import { h, loveIcon } from '../ui.js';

export function chatPane(engine) {
  let tab = 'chats';
  let seenChats = 0; let seenReq = 0;
  let feedKey = ''; let reqKey = '';

  const tabChats = h('button', { class: 'tab on', type: 'button' }, 'Chats ', h('span', { class: 'ubadge', hidden: true }));
  const tabReq = h('button', { class: 'tab', type: 'button' }, 'Requests ', h('span', { class: 'ubadge', hidden: true }));
  const feed = h('div', { class: 'chat-list', role: 'log' });
  const reqBox = h('div', { class: 'req-list', hidden: true });
  const chatIn = h('input', { placeholder: 'Say something as the host…', maxlength: 300, 'aria-label': 'Message' });
  const send = () => { const t = chatIn.value.trim(); if (t) { engine.send({ t: 'chat', text: t }); chatIn.value = ''; } };
  chatIn.onkeydown = (e) => { if (e.key === 'Enter') send(); };
  const composer = h('div', { class: 'row' }, h('div', { class: 'grow' }, chatIn), h('button', { class: 'btn small', type: 'button', onclick: send }, 'Send'));

  const open = (which) => {
    tab = which;
    tabChats.classList.toggle('on', which === 'chats'); tabReq.classList.toggle('on', which === 'requests');
    feed.hidden = which !== 'chats'; reqBox.hidden = which !== 'requests'; composer.hidden = which !== 'chats';
    paint();
    if (which === 'chats') feed.scrollTop = feed.scrollHeight;
  };
  tabChats.onclick = () => open('chats'); tabReq.onclick = () => open('requests');

  /* ----- lines ----- */
  const chatLine = (c) => {
    const who = c.host ? h('b', { class: 'host' }, c.name) : h('b', {}, c.name, h('span', { class: 'muted' }, ` ·${c.uid8}`));
    const menu = h('span', { class: 'cmenu' },
      h('button', { class: 'lnk', type: 'button', title: 'Mute this person', onclick: () => engine.send({ t: 'mute', uid: c.uid8, on: true }) }, 'mute'),
      h('button', { class: 'lnk', type: 'button', title: 'Delete', onclick: () => engine.send({ t: 'delchat', id: c.id }) }, 'delete'));
    return h('div', { class: 'cline' }, who, ' ', h('span', {}, c.text), menu);
  };
  const lineFor = (e) => {
    if (e.kind === 'chat') return chatLine(e.c);
    if (e.kind === 'joined') return h('div', { class: 'cline sys' }, `${e.name} joined`);
    if (e.kind === 'love') return h('div', { class: 'cline love' }, loveIcon(14), ` ${e.name} ×${e.total}`);
    return h('div', { class: 'cline' }, h('b', {}, e.name, h('span', { class: 'muted' }, e.uid8 ? ` ·${e.uid8}` : '')), ' ', h('span', {}, e.text), h('span', { class: 'rlabel' }, 'request'));
  };
  const reqLine = (r) => {
    const act = (a, l) => h('button', { class: 'btn small', type: 'button', onclick: () => engine.send({ t: 'req', id: r.id, action: a }) }, l);
    return h('div', { class: 'rline' + (r.status === 'reading' ? ' now' : '') + (r.status === 'done' ? ' done' : '') },
      h('div', { class: 'grow' }, h('span', {}, r.text), h('div', { class: 'small muted' }, `${r.name} ·${(r.uid || '').slice(0, 4)}${r.status === 'reading' ? ' · reading now' : r.status === 'done' ? ' · done' : ''}`)),
      r.status === 'reading' ? act('done', 'Done') : [act('reading', 'Reading'), r.status === 'done' ? act('queue', 'Requeue') : act('up', '↑')], act('dismiss', '✕'));
  };

  function paint() {
    const s = engine.s;
    const room = s.room;
    // everything for the Chats tab, in time order
    const all = [...s.chat.map((c) => ({ kind: 'chat', at: c.at, seq: c.seq, c })), ...s.events];
    all.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
    const k = all.map((e) => `${e.seq}:${e.total || ''}`).join(',');
    if (k !== feedKey) {
      const atEnd = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
      feed.replaceChildren(...(all.length ? all.map(lineFor) : [h('p', { class: 'muted small' }, 'Nothing yet. Chat, requests and Love show up here.')]));
      if (atEnd) feed.scrollTop = feed.scrollHeight;
      feedKey = k;
    }
    // the Requests tab
    const list = (room?.requests || []).filter((r) => r.status !== 'dismissed');
    const rk = JSON.stringify(list.map((r) => [r.id, r.status]));
    if (rk !== reqKey) { reqBox.replaceChildren(...(list.length ? list.map(reqLine) : [h('p', { class: 'muted small' }, 'No requests yet.')])); reqKey = rk; }
    // unread: what arrived since each tab was last open (what was already there when the console opened does not count)
    if (tab === 'chats') seenChats = s.seq;
    if (tab === 'requests') seenReq = s.seq;
    const base = s.baseSeq == null ? Infinity : s.baseSeq;
    const mine = (e) => !(e.kind === 'chat' && e.c.host);
    const nChats = all.filter((e) => e.seq > Math.max(seenChats, base) && mine(e)).length;
    const nReq = s.events.filter((e) => e.kind === 'request' && e.seq > Math.max(seenReq, base)).length;
    for (const [btn, n] of [[tabChats, nChats], [tabReq, nReq]]) { const b = btn.querySelector('.ubadge'); b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); }
    const closed = s.phase === 'ended' || room?.you?.chat === 'closed';
    chatIn.disabled = closed;
  }

  const el = h('section', { class: 'card c-chat' }, h('div', { class: 'row c-tabs' }, tabChats, tabReq), feed, reqBox, composer);
  return { el, paint };
}
