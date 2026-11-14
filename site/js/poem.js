// One poem: player, text, reactions and comments.
import { h, fmtDur, fmtDate, fmtWhen, toast } from '../shared/dom.js';
import { initAuth, mountAccountChip, getSession, onAuth, requireAuth } from './auth-ui.js';
import * as data from './data.js';

const REACTIONS = [['love', 'Love', '❤️'], ['like', 'Like', '👍'], ['emotional', 'Emotional', '🥲'], ['funny', 'Funny', '😂']];
const getId = () => new URLSearchParams(location.search).get('id') || (location.pathname.match(/^\/p\/([0-9a-f-]{36})/) || [])[1] || '';

async function main() {
  mountAccountChip(document.getElementById('account'));
  const root = document.getElementById('poem');
  await initAuth();
  const id = getId();
  let item = null;
  try { item = id ? await data.getItem(id) : null; } catch (e) { root.replaceChildren(h('p', { class: 'empty' }, 'Could not load this poem. ' + data.friendly(e))); return; }
  if (!item) { root.replaceChildren(h('p', { class: 'empty' }, 'This poem is not available.'), h('p', {}, h('a', { href: '/' }, 'Back to all poems'))); return; }
  document.title = `${item.title} | Fabris Poet`;

  /* media */
  const src = data.mediaUrl(item.public_media_key);
  const thumb = data.mediaUrl(item.public_thumb_key);
  const player = item.kind === 'video'
    ? h('video', { class: 'player', controls: true, playsinline: true, preload: 'metadata', poster: thumb, src })
    : h('div', {}, thumb ? h('img', { class: 'cover', src: thumb, alt: '' }) : null, h('audio', { class: 'player', controls: true, preload: 'metadata', src }));
  const media = player.tagName === 'VIDEO' ? player : player.querySelector('audio');
  media.addEventListener('play', () => data.recordPlay(id), { once: true });

  /* reactions */
  let mine = null;
  const counts = {};
  const buttons = REACTIONS.map(([type, label, icon]) => {
    const n = h('span', { class: 'n' }, '0');
    counts[type] = n;
    const b = h('button', { class: 'react', 'data-type': type, 'aria-label': label, 'aria-pressed': 'false', disabled: !item.reactions_enabled, onclick: () => react(type) }, h('span', { 'aria-hidden': 'true' }, icon), h('span', { class: 'lbl' }, label), n);
    return b;
  });
  const paintCounts = (row) => {
    for (const [type] of REACTIONS) counts[type].textContent = String(row['n_' + type] ?? 0);
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === mine)));
    plays.textContent = `${row.n_plays} plays`;
  };
  const plays = h('span', { class: 'muted small' });
  async function refresh() {
    try { const row = await data.getItem(id); if (row) paintCounts(row); } catch { /* keep what is shown */ }
  }
  let mineSeq = 0; // a newer action always wins over a slower, older lookup
  async function loadMine() {
    const seq = ++mineSeq;
    const s = getSession();
    const found = s ? await data.myReaction(id, s.user.id).catch(() => null) : null;
    if (seq !== mineSeq) return;
    mine = found;
    refresh();
  }
  async function react(type) {
    const s = await requireAuth('Continue as a guest, or sign in, to react.');
    if (!s) return;
    mineSeq++;
    try {
      if (mine === type) { await data.clearReaction(id, s.user.id); mine = null; }
      else { await data.setReaction(id, s.user.id, type); mine = type; }
      await refresh();
    } catch (e) { toast(data.friendly(e)); }
  }

  /* comments */
  const list = h('div', { class: 'comments' });
  async function loadComments() {
    try {
      const rows = await data.listComments(id);
      const me = getSession()?.user?.id;
      list.replaceChildren(...(rows.length ? rows.map((c) => h('div', { class: 'comment' },
        h('div', { class: 'who' }, h('strong', {}, c.nickname), h('span', { class: 'muted small' }, ' ' + fmtWhen(c.created_at)),
          c.user_id === me ? h('button', { class: 'btn link small', onclick: async () => { try { await data.deleteComment(c.id); loadComments(); refresh(); } catch (e) { toast(data.friendly(e)); } } }, 'Delete') : null),
        h('p', {}, c.body))) : [h('p', { class: 'muted' }, 'No comments yet. Be the first.')]));
    } catch { list.replaceChildren(h('p', { class: 'muted' }, 'Comments could not be loaded.')); }
  }
  const nick = h('input', { value: data.getNickname(), placeholder: 'Your nickname', maxlength: 30, 'aria-label': 'Nickname' });
  const text = h('textarea', { placeholder: 'Write a comment', rows: 3, maxlength: 500, 'aria-label': 'Comment' });
  const send = h('button', { class: 'btn primary', onclick: async () => {
    const body = text.value.trim();
    const name = nick.value.trim();
    if (!name) return toast('Add a nickname first.');
    if (!body) return toast('Write something first.');
    const s = await requireAuth('Continue as a guest, or sign in, to comment.');
    if (!s) return;
    send.disabled = true;
    try {
      await data.saveNickname(name);
      await data.postComment(id, s.user.id, name, body);
      text.value = '';
      await loadComments();
      refresh();
    } catch (e) { toast(data.friendly(e)); }
    send.disabled = false;
  } }, 'Post comment');

  /* page */
  const share = h('button', { class: 'btn', onclick: async () => {
    const url = `${location.origin}/p/${id}`;
    if (navigator.share) { try { await navigator.share({ title: item.title, url }); } catch { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast(url); }
  } }, 'Share');

  const stanzas = (item.poem_stanzas || []).filter(Boolean);
  root.replaceChildren(
    player,
    h('h1', {}, item.title),
    h('p', { class: 'meta' }, `${fmtDate(item.published_at)}, ${fmtDur(item.duration)} `, plays),
    item.description ? h('p', { class: 'desc' }, item.description) : null,
    stanzas.length ? h('div', { class: 'poem-text' }, h('h2', { class: 'sr' }, 'Poem text'), stanzas.map((s) => h('p', { class: 'stanza' }, s))) : null,
    h('p', { class: 'sign' }, 'FabisPot'),
    item.reactions_enabled ? h('div', { class: 'reacts', role: 'group', 'aria-label': 'Reactions' }, buttons, share) : h('div', { class: 'reacts' }, share),
    h('section', { class: 'comments-box' }, h('h2', {}, 'Comments'),
      item.comments_enabled
        ? h('div', { class: 'compose' }, nick, text, send)
        : h('p', { class: 'muted' }, 'Comments are closed for this poem.'),
      list));
  paintCounts(item);
  loadComments();
  loadMine();
  onAuth(() => { loadMine(); loadComments(); });
}
main();
