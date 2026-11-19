// One poem: sliding title, player, time and views, description, Like, comments.
// (Love was removed from posts. Old Love data stays in the database, hidden; Love on a live is a different thing.)
import { h, fmtDur, fmtAgo, fmtWhen, toast } from '../shared/dom.js';
import { initAuth, mountAccountChip, getSession, onAuth, requireAuth, guestReady, displayName } from './auth-ui.js';
import * as data from './data.js';
import { maybeInvite } from './invite.js';

const svg = (inner, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="${cls}">${inner}</svg>`;
const ICON = {
  love: svg('<path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>'),
  like: svg('<path d="M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 2 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"/>'),
  comment: svg('<path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1"/>'),
  share: svg('<path d="M6 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M18 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M8.7 10.7l6.6 -3.4"/><path d="M8.7 13.3l6.6 3.4"/>'),
  send: svg('<path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/>'),
  play: svg('<path d="M8 5v14l11 -7z"/>', 'solid'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>', 'solid'),
};
const icon = (name) => { const s = h('span', { class: 'ico' }); s.innerHTML = ICON[name]; return s; };
const getId = () => new URLSearchParams(location.search).get('id') || (location.pathname.match(/^\/p\/([0-9a-f-]{36})/) || [])[1] || '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };

/* ---------- the title: one line, slides slowly when it is too long ---------- */
function slideTitle(box, text) {
  let anim = null;
  const run = () => {
    if (anim) { anim.cancel(); anim = null; }
    if (reducedMotion() || !text.animate) return;
    const shift = text.offsetWidth - box.clientWidth;
    if (shift > 4) {
      anim = text.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(-${shift}px)` }],
        { duration: shift * 45, direction: 'alternate', iterations: Infinity, easing: 'linear', delay: 1500, endDelay: 1500 },
      );
    }
  };
  run();
  window.addEventListener('resize', debounce(run, 200));
}

/* ---------- the description: one line with "more...", opens to the whole text ---------- */
function descBlock(body) {
  const t = h('span', { class: 't' }, body);
  const m = h('span', { class: 'm', role: 'button', tabindex: '0' }, 'more...');
  const d = h('p', { class: 'desc' }, t, m);
  const flip = () => { const open = d.classList.toggle('open'); m.textContent = open ? 'less' : 'more...'; };
  m.addEventListener('click', flip);
  m.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  // Only offer "more..." when the text really is longer than one line.
  const fit = () => {
    if (d.classList.contains('open')) return;
    m.hidden = true;
    m.hidden = !(t.scrollWidth > t.clientWidth || /\n/.test(body));
  };
  return { el: d, fit };
}

/* ---------- audio: thumbnail with the play button inside and wave bars while it plays ---------- */
function audioStage({ src, thumb, duration }) {
  const BARS = 24;
  // crossorigin lets the page read the sound for the wave bars. If the file cannot be fetched that way, play it plainly.
  const audio = h('audio', { crossorigin: 'anonymous', preload: 'metadata', src });
  audio.hidden = true;
  let analyse = true;
  audio.addEventListener('error', () => {
    if (analyse && audio.getAttribute('crossorigin')) {
      analyse = false;
      audio.removeAttribute('crossorigin');
      audio.src = src;
    }
  });

  const bars = Array.from({ length: BARS }, () => h('b'));
  const barsEl = h('div', { class: 'bars', 'aria-hidden': 'true' }, bars);
  const btn = h('button', { class: 'pbtn', type: 'button', 'aria-label': 'Play' });
  const setIcon = (playing) => { btn.innerHTML = playing ? ICON.pause : ICON.play; btn.setAttribute('aria-label', playing ? 'Pause' : 'Play'); };
  setIcon(false);

  const seek = h('input', { type: 'range', min: '0', max: String(Math.max(1, Math.round(duration || 0))), step: '0.1', value: '0', 'aria-label': 'Seek' });
  const time = h('span', {}, `0:00 / ${fmtDur(duration)}`);
  const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration || 0);
  const paintTime = () => {
    seek.max = String(dur());
    seek.value = String(audio.currentTime);
    time.textContent = `${fmtDur(audio.currentTime)} / ${fmtDur(dur())}`;
  };
  ['timeupdate', 'loadedmetadata', 'durationchange'].forEach((ev) => audio.addEventListener(ev, paintTime));
  seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); paintTime(); });

  /* wave bars: real sound when the browser allows it, a smooth moving pattern when not */
  let ctx = null;
  let analyser = null;
  let freq = null;
  let fake = false;
  const setupAnalyser = () => {
    if (ctx || fake) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !analyse || !audio.getAttribute('crossorigin')) { fake = true; return; }
    try {
      ctx = new AC();
      const node = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      node.connect(analyser);
      analyser.connect(ctx.destination);
      freq = new Uint8Array(analyser.frequencyBinCount);
    } catch { fake = true; ctx = null; analyser = null; }
  };
  const rest = () => bars.forEach((b) => { b.style.transform = 'scaleY(.08)'; });
  rest();
  let raf = 0;
  const frame = (now) => {
    raf = 0;
    if (audio.paused) return;
    if (analyser) {
      analyser.getByteFrequencyData(freq);
      for (let i = 0; i < BARS; i++) {
        const v = Math.pow(freq[1 + Math.floor((i * 40) / BARS)] / 255, 1.15);
        bars[i].style.transform = `scaleY(${Math.max(0.08, v).toFixed(3)})`;
      }
    } else {
      for (let i = 0; i < BARS; i++) {
        const v = 0.3 + 0.7 * Math.abs(Math.sin(now / 260 + i * 0.7) * Math.cos(now / 510 + i * 0.35));
        bars[i].style.transform = `scaleY(${v.toFixed(3)})`;
      }
    }
    raf = requestAnimationFrame(frame);
  };
  audio.addEventListener('play', () => { setIcon(true); if (!raf) raf = requestAnimationFrame(frame); });
  const stopped = () => { setIcon(false); rest(); };
  audio.addEventListener('pause', stopped);
  audio.addEventListener('ended', stopped);

  btn.addEventListener('click', () => {
    if (!audio.paused) { audio.pause(); return; }
    setupAnalyser();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    const p = audio.play();
    if (p && p.catch) p.catch(() => toast('Could not play this audio.'));
  });

  const el = h('div', { class: 'stage' },
    thumb ? h('img', { src: thumb, alt: '' }) : null,
    barsEl, btn, h('div', { class: 'tl' }, seek, time), audio);
  return { el };
}

async function main() {
  mountAccountChip(document.getElementById('account'));
  const root = document.getElementById('poem');
  await initAuth({ guest: true }); // a visitor with no session silently gets a guest account
  const id = getId();
  let item = null;
  try { item = id ? await data.getItem(id) : null; } catch (e) { root.replaceChildren(h('p', { class: 'empty' }, 'Could not load this poem. ' + data.friendly(e))); return; }
  if (!item) { root.replaceChildren(h('p', { class: 'empty' }, 'This poem is not available.'), h('p', {}, h('a', { href: '/' }, 'Back to all poems'))); return; }
  if (item.kind === 'live' && !item.public_media_key) { location.replace(`/live/?id=${id}`); return; }
  document.title = `${item.title} | Fabris Poet`;

  // The view belongs to the guest (or real) account as soon as it exists.
  guestReady().then((s) => { if (s) data.recordView(id, s.user.id); });

  // After a poem has been played to its end, people without an account are invited to create one (once every 3 days).
  document.addEventListener('ended', (e) => { if (e.target instanceof HTMLMediaElement) setTimeout(maybeInvite, 900); }, true);

  /* media */
  const src = data.mediaUrl(item.public_media_key);
  const thumb = data.mediaUrl(item.public_thumb_key);
  const media = item.kind === 'video'
    ? h('video', { class: 'player', controls: true, playsinline: true, preload: 'metadata', poster: thumb, src })
    : audioStage({ src, thumb, duration: item.duration }).el;

  /* Like and the comment button */
  let mine = new Set();
  const nLike = h('span', { class: 'n' }, '0');
  const nCom = h('span', { class: 'n' }, '0');
  const reactBtn = (type, label, n) => h('button', {
    class: 'react', 'data-type': type, 'aria-label': label, 'aria-pressed': 'false', disabled: !item.reactions_enabled, onclick: () => react(type),
  }, icon(type), n);
  const likeBtn = reactBtn('like', 'Like', nLike);
  const comBtn = h('button', { class: 'react', 'data-type': 'comment', 'aria-label': 'Comments', 'aria-expanded': 'false', onclick: () => toggleComments() }, icon('comment'), nCom);
  const views = h('span', {});

  const paintPressed = () => {
    likeBtn.setAttribute('aria-pressed', String(mine.has('like')));
  };
  const paintCounts = (row) => {
    nLike.textContent = String(row.n_like ?? 0);
    nCom.textContent = String(row.n_comments ?? 0);
    views.textContent = plural(row.n_views ?? 0, 'view');
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
  const text = h('textarea', { class: 'chat-input', placeholder: 'Write a comment', rows: 1, maxlength: 500, 'aria-label': 'Comment' });
  const grow = () => { text.style.height = 'auto'; text.style.height = Math.min(text.scrollHeight, 120) + 'px'; };
  text.addEventListener('input', grow);
  const send = h('button', { class: 'send', type: 'button', 'aria-label': 'Send comment', onclick: async () => {
    const body = text.value.trim();
    if (!body) return toast('Write something first.');
    const s = await requireAuth();
    if (!s) return;
    send.disabled = true;
    try {
      // The name is the account name, or "Guest" and the first four characters of the guest id.
      await data.postComment(id, s.user.id, displayName().slice(0, 30), body);
      text.value = '';
      grow();
      await loadComments();
      refresh();
    } catch (e) { toast(data.friendly(e)); }
    send.disabled = false;
  } });
  send.innerHTML = ICON.send;
  send.addEventListener('pointerdown', (e) => e.preventDefault()); // keeps the keyboard open while sending
  const panel = h('div', { class: 'comment-panel' }, list,
    item.comments_enabled ? h('div', { class: 'chat' }, text, send) : h('p', { class: 'muted' }, 'Comments are closed for this poem.'));
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

  /* more from Fabris: the latest other poems, just a thumbnail and a name */
  const moreGrid = h('div', { class: 'mini-grid' });
  const moreBox = h('section', { class: 'more' }, h('h2', {}, 'More from Fabris'), moreGrid);
  moreBox.hidden = true;
  const miniCard = (it) => {
    const t = data.mediaUrl(it.public_thumb_key);
    const badge = h('span', { class: 'badge' });
    badge.innerHTML = ICON.play;
    return h('a', { class: 'mini', href: `/poem/?id=${it.id}` },
      h('div', { class: 'th' }, t ? h('img', { src: t, alt: '', loading: 'lazy' }) : null, badge),
      h('p', { class: 'nm' }, it.title || 'Untitled'));
  };
  async function loadMore() {
    try {
      const others = await data.listMore(id);
      if (!others.length) return;
      moreGrid.replaceChildren(...others.map(miniCard));
      moreBox.hidden = false;
    } catch { /* the section simply stays hidden */ }
  }

  /* page */
  const shareBtn = h('button', { class: 'react share', 'aria-label': 'Share', onclick: async () => {
    const url = `${location.origin}/p/${id}`;
    if (navigator.share) { try { await navigator.share({ title: item.title, url }); } catch { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast(url); }
  } }, icon('share'));

  const titleText = h('h1', {}, item.title);
  const titleBox = h('div', { class: 'ttl' }, titleText);
  const description = (item.description || '').trim() ? descBlock(item.description.trim()) : null;

  // Native replaceChildren() would print a missing item as the word "null", so only real items go in.
  root.replaceChildren(...[
    titleBox,
    media,
    h('p', { class: 'meta' }, fmtAgo(item.published_at), ' · ', views),
    description ? description.el : null,
    h('div', { class: 'reacts', role: 'group', 'aria-label': 'Reactions and comments' }, likeBtn, comBtn, shareBtn),
    h('section', { class: 'comments-box' }, h('h2', { class: 'sr' }, 'Comments'), preview, panel),
    moreBox,
  ].filter(Boolean));
  paintCounts(item);
  paintComments();
  requestAnimationFrame(() => {
    slideTitle(titleBox, titleText);
    if (description) { description.fit(); window.addEventListener('resize', debounce(description.fit, 200)); }
  });
  loadComments();
  loadMore();
  loadMine();
  onAuth(() => { loadMine(); loadComments(); });
}
main();
