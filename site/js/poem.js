// One poem: player, text, Love and Like, comments.
import { h, fmtDur, fmtDate, fmtWhen, toast } from '../shared/dom.js';
import { initAuth, mountAccountChip, getSession, onAuth, requireAuth, guestReady } from './auth-ui.js';
import * as data from './data.js';

const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
const ICON = {
  love: svg('<path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>'),
  like: svg('<path d="M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 2 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"/>'),
  comment: svg('<path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1"/>'),
  share: svg('<path d="M6 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M18 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M8.7 10.7l6.6 -3.4"/><path d="M8.7 13.3l6.6 3.4"/>'),
};
const icon = (name) => { const s = h('span', { class: 'ico' }); s.innerHTML = ICON[name]; return s; };
const getId = () => new URLSearchParams(location.search).get('id') || (location.pathname.match(/^\/p\/([0-9a-f-]{36})/) || [])[1] || '';

async function main() {
  mountAccountChip(document.getElementById('account'));
  const root = document.getElementById('poem');
  await initAuth({ guest: true }); // a visitor with no session silently gets a guest account
  const id = getId();
  let item = null;
  try { item = id ? await data.getItem(id) : null; } catch (e) { root.replaceChildren(h('p', { class: 'empty' }, 'Could not load this poem. ' + data.friendly(e))); return; }
  if (!item) { root.replaceChildren(h('p', { class: 'empty' }, 'This poem is not available.'), h('p', {}, h('a', { href: '/' }, 'Back to all poems'))); return; }
  document.title = `${item.title} | Fabris Poet`;

  // The view belongs to the guest (or real) account as soon as it exists.
  guestReady().then((s) => { if (s) data.recordView(id, s.user.id); });

  /* media */
  const src = data.mediaUrl(item.public_media_key);
  const thumb = data.mediaUrl(item.public_thumb_key);
  const player = item.kind === 'video'
    ? h('video', { class: 'player', controls: true, playsinline: true, preload: 'metadata', poster: thumb, src })
    : h('div', {}, thumb ? h('img', { class: 'cover', src: thumb, alt: '' }) : null, h('audio', { class: 'player', controls: true, preload: 'metadata', src }));

  /* Love, Like and the comment button */
  let mine = new Set();
  const nLove = h('span', { class: 'n' }, '0');
  const nLike = h('span', { class: 'n' }, '0');
  const nCom = h('span', { class: 'n' }, '0');
  const reactBtn = (type, label, n) => h('button', {
    class: 'react', 'data-type': type, 'aria-label': label, 'aria-pressed': 'false', disabled: !item.reactions_enabled, onclick: () => react(type),
  }, icon(type), n);
  const loveBtn = reactBtn('love', 'Love', nLove);
  const likeBtn = reactBtn('like', 'Like', nLike);
  const comBtn = h('button', { class: 'react', 'data-type': 'comment', 'aria-label': 'Comments', 'aria-expanded': 'false', onclick: () => toggleComments() }, icon('comment'), nCom);
  const views = h('span', { class: 'muted small' });

  const paintPressed = () => {
    loveBtn.setAttribute('aria-pressed', String(mine.has('love')));
    likeBtn.setAttribute('aria-pressed', String(mine.has('like')));
  };
  const paintCounts = (row) => {
    nLove.textContent = String(row.n_love ?? 0);
    nLike.textContent = String(row.n_like ?? 0);
    nCom.textContent = String(row.n_comments ?? 0);
    views.textContent = `${row.n_views ?? 0} views`;
    paintPressed();
  };
  async function refresh() {
    try { const row = await data.getItem(id); if (row) paintCounts(row); } catch { /* keep what is shown */ }
  }
  let mineSeq = 0; // a newer action always wins over a slower, older lookup
  async function loadMine() {
    const seq = ++mineSeq;
    const s = getSession();
    const found = s ? await data.myReactions(id, s.user.id).catch(() => null) : null;
    if (seq !== mineSeq) return;
    mine = new Set(found || []);
    paintPressed();
    refresh();
  }
  async function react(type) {
    const s = await requireAuth();
    if (!s) return;
    mineSeq++;
    try {
      if (mine.has(type)) { await data.clearReaction(id, s.user.id, type); mine.delete(type); }
      else { await data.setReaction(id, s.user.id, type); mine.add(type); }
      paintPressed();
      await refresh();
    } catch (e) { toast(data.friendly(e)); }
  }

  /* comments: the latest one shows by default; the comment button opens the rest and the box to write */
  let rows = [];
  let open = false;
  const preview = h('div', { class: 'comment-preview' });
  const list = h('div', { class: 'comments' });
  const nick = h('input', { value: data.getNickname(), placeholder: 'Your nickname', maxlength: 30, 'aria-label': 'Nickname' });
  const text = h('textarea', { placeholder: 'Write a comment', rows: 3, maxlength: 500, 'aria-label': 'Comment' });
  const send = h('button', { class: 'btn primary', onclick: async () => {
    const body = text.value.trim();
    const name = nick.value.trim();
    if (!name) return toast('Add a nickname first.');
    if (!body) return toast('Write something first.');
    const s = await requireAuth();
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
  const panel = h('div', { class: 'comment-panel' }, list,
    item.comments_enabled ? h('div', { class: 'compose' }, nick, text, send) : h('p', { class: 'muted' }, 'Comments are closed for this poem.'));
  panel.hidden = true;

  const commentEl = (c, withDelete) => h('div', { class: 'comment' },
    h('div', { class: 'who' }, h('strong', {}, c.nickname), h('span', { class: 'muted small' }, ' ' + fmtWhen(c.created_at)),
      withDelete && c.user_id === getSession()?.user?.id
        ? h('button', { class: 'btn link small', onclick: async () => { try { await data.deleteComment(c.id); await loadComments(); refresh(); } catch (e) { toast(data.friendly(e)); } } }, 'Delete')
        : null),
    h('p', {}, c.body));

  function paintComments() {
    preview.replaceChildren(rows.length ? commentEl(rows[0], false) : h('p', { class: 'muted small' }, 'No comments yet.'));
    list.replaceChildren(...(rows.length ? rows.map((c) => commentEl(c, true)) : [h('p', { class: 'muted' }, 'No comments yet. Be the first.')]));
    preview.hidden = open;
    panel.hidden = !open;
    comBtn.setAttribute('aria-expanded', String(open));
  }
  async function loadComments() {
    try { rows = await data.listComments(id); }
    catch { list.replaceChildren(h('p', { class: 'muted' }, 'Comments could not be loaded.')); return; }
    paintComments();
  }
  function toggleComments() { open = !open; paintComments(); }

  /* page */
  const shareBtn = h('button', { class: 'react share', 'aria-label': 'Share', onclick: async () => {
    const url = `${location.origin}/p/${id}`;
    if (navigator.share) { try { await navigator.share({ title: item.title, url }); } catch { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast(url); }
  } }, icon('share'));

  const stanzas = (item.poem_stanzas || []).filter(Boolean);
  root.replaceChildren(
    player,
    h('h1', {}, item.title),
    h('p', { class: 'meta' }, `${fmtDate(item.published_at)}, ${fmtDur(item.duration)} `, views),
    item.description ? h('p', { class: 'desc' }, item.description) : null,
    stanzas.length ? h('div', { class: 'poem-text' }, h('h2', { class: 'sr' }, 'Poem text'), stanzas.map((s) => h('p', { class: 'stanza' }, s))) : null,
    h('p', { class: 'sign' }, 'FabisPot'),
    h('div', { class: 'reacts', role: 'group', 'aria-label': 'Reactions and comments' }, loveBtn, likeBtn, comBtn, shareBtn),
    h('section', { class: 'comments-box' }, h('h2', { class: 'sr' }, 'Comments'), preview, panel));
  paintCounts(item);
  paintComments();
  loadComments();
  loadMine();
  onAuth(() => { loadMine(); loadComments(); });
}
main();
