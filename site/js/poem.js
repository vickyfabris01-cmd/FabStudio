// One poem: sliding title, player, time and views, description, Like, comments.
// (Love was removed from posts. Old Love data stays in the database, hidden; Love on a live is a different thing.)
import { h, fmtDur, fmtAgo, fmtWhen, toast } from '../shared/dom.js';
import { initAuth, mountAccountChip, getSession, onAuth, requireAuth, guestReady, displayName } from './auth-ui.js';
import * as data from './data.js';
import { maybeInvite } from './invite.js';
import { downloadName, extOf } from '../shared/dl-name.js';
import { drawScene, SCENE_W, SCENE_H } from '../shared/scene.js';

const svg = (inner, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="${cls}">${inner}</svg>`;
const ICON = {
  love: svg('<path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"/>'),
  like: svg('<path d="M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 2 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"/>'),
  comment: svg('<path d="M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1"/>'),
  share: svg('<path d="M6 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M18 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M18 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M8.7 10.7l6.6 -3.4"/><path d="M8.7 13.3l6.6 3.4"/>'),
  send: svg('<path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/>'),
  download: svg('<path d="M12 4v11"/><path d="M7.5 11l4.5 4.5l4.5 -4.5"/><path d="M5 19h14"/>'),
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
function audioStage({ src, thumb, duration, title = '', scene = null, bgUrl = '', lyrics = null }) {
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

  /* the animated screen (when the item has one): a canvas replaces the picture and the bars. It is drawn by the same
     function that makes the video file, from a few KB of settings, so it costs listeners no extra data. */
  const useScene = !!scene;
  const levels = new Array(32).fill(0.03);
  const SW = 960;
  const SH = 540;
  let sceneCv = null;
  let sceneCtx = null;
  let bgImg = null;
  let markImg = null;
  const drawNow = () => {
    if (!sceneCtx) return;
    sceneCtx.save();
    sceneCtx.scale(SW / SCENE_W, SH / SCENE_H);
    drawScene(sceneCtx, SCENE_W, SCENE_H, { t: audio.currentTime || 0, bars: levels, title, bg: bgImg, mark: markImg, lyrics, anim: scene && scene.lyricAnim });
    sceneCtx.restore();
  };
  if (useScene) {
    sceneCv = h('canvas', { class: 'scene', width: SW, height: SH, 'aria-hidden': 'true' });
    sceneCtx = sceneCv.getContext('2d');
    const load = (url) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
    Promise.all([bgUrl ? load(bgUrl) : null, load('/img/fabris-poet-mark.png')]).then(([b, m]) => { bgImg = b; markImg = m; drawNow(); });
    audio.addEventListener('seeked', drawNow);
    audio.addEventListener('loadedmetadata', drawNow);
  }

  let raf = 0;
  const frame = (now) => {
    raf = 0;
    if (audio.paused) return;
    if (analyser) analyser.getByteFrequencyData(freq);
    const level = (i, n) => (analyser
      ? Math.pow(freq[1 + Math.floor((i * 40) / n)] / 255, 1.15)
      : 0.3 + 0.7 * Math.abs(Math.sin(now / 260 + i * 0.7) * Math.cos(now / 510 + i * 0.35)));
    if (useScene) {
      for (let i = 0; i < levels.length; i++) levels[i] = Math.max(0.03, level(i, levels.length));
      drawNow();
    } else {
      for (let i = 0; i < BARS; i++) bars[i].style.transform = `scaleY(${Math.max(0.08, level(i, BARS)).toFixed(3)})`;
    }
    raf = requestAnimationFrame(frame);
  };
  audio.addEventListener('play', () => { setIcon(true); if (!raf) raf = requestAnimationFrame(frame); });
  const stopped = () => { setIcon(false); rest(); if (useScene) { levels.fill(0.03); drawNow(); } };
  audio.addEventListener('pause', stopped);
  audio.addEventListener('ended', stopped);

  btn.addEventListener('click', () => {
    if (!audio.paused) { audio.pause(); return; }
    setupAnalyser();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    const p = audio.play();
    if (p && p.catch) p.catch(() => toast('Could not play this audio.'));
  });

  const el = h('div', { class: 'stage' + (useScene ? ' scened' : '') },
    useScene ? sceneCv : (thumb ? h('img', { src: thumb, alt: '' }) : null),
    useScene ? null : barsEl, btn, h('div', { class: 'tl' }, seek, time), audio);
  return { el, audio };
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

  /* media: an item has an audio file and (when made) a video file. Listeners choose Listen or Watch; their last
     choice is remembered, nothing switches by itself, and a switch carries on from the same second. */
  const src = data.mediaUrl(item.public_media_key);
  const thumb = data.mediaUrl(item.public_thumb_key);
  const audioKey = item.kind === 'video' ? item.public_alt_key : item.public_media_key;
  const videoKey = item.kind === 'video' ? item.public_media_key : item.public_alt_key;
  const audioUrl = data.mediaUrl(audioKey);
  const videoUrl = data.mediaUrl(videoKey);
  const sceneOn = item.kind === 'audio' && item.scene;
  const lyricLines = sceneOn && Array.isArray(item.lyrics) && item.lyrics.length ? item.lyrics : null;

  // The album of this item (the parts of one live's recap), in order. Empty for ordinary items.
  let parts = [];
  if (item.source_live_id) { try { parts = await data.albumParts(item.source_live_id); } catch { parts = []; } }
  const partIx = parts.findIndex((x) => x.id === id);
  const nextPart = () => (parts.length ? parts[(partIx + 1) % parts.length] : null);
  const prevPart = () => (parts.length ? parts[(partIx - 1 + parts.length) % parts.length] : null);
  const goPart = (x) => { if (!x) return; if (x.id === id) { const m = player.media(); m.currentTime = 0; m.play().catch(() => {}); } else location.assign(`/poem/?id=${x.id}&play=1`); };

  const player = buildPlayer();
  function buildPlayer() {
    const both = !!(audioUrl && videoUrl);
    const KEY = 'fp.mode';
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
    let mode = both ? (saved === 'watch' || saved === 'listen' ? saved : (item.kind === 'video' ? 'watch' : 'listen')) : (videoUrl && !audioUrl ? 'watch' : 'listen');
    const slot = h('div', { class: 'player-slot' });
    let cur = null;

    const wire = (m) => {
      m.addEventListener('ended', () => { if (parts.length) goPart(nextPart()); });
      m.addEventListener('play', () => {
        if (!('mediaSession' in navigator)) return;
        try {
          navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: 'Fabris Poet', album: item.album_title || '', artwork: thumb ? [{ src: thumb, sizes: '1280x720', type: 'image/jpeg' }] : [] });
          navigator.mediaSession.setActionHandler('play', () => m.play());
          navigator.mediaSession.setActionHandler('pause', () => m.pause());
          navigator.mediaSession.setActionHandler('seekto', (d) => { m.currentTime = d.seekTime; });
          navigator.mediaSession.setActionHandler('previoustrack', parts.length > 1 ? () => goPart(prevPart()) : null);
          navigator.mediaSession.setActionHandler('nexttrack', parts.length > 1 ? () => goPart(nextPart()) : null);
        } catch { /* lock screen controls are optional */ }
      });
    };
    const mount = (m, at = 0, resume = false) => {
      let media;
      if (m === 'watch') {
        media = h('video', { class: 'player', controls: true, playsinline: true, preload: 'metadata', poster: thumb, src: videoUrl });
        slot.replaceChildren(media);
      } else {
        const st = audioStage({ src: audioUrl, thumb, duration: item.duration, title: item.title, scene: sceneOn ? item.scene : null, bgUrl: data.mediaUrl(item.public_bg_key), lyrics: lyricLines });
        media = st.audio;
        slot.replaceChildren(st.el);
      }
      cur = { media, mode: m };
      wire(media);
      if (at > 0) media.addEventListener('loadedmetadata', () => { try { media.currentTime = at; } catch { /* the start stays */ } }, { once: true });
      if (resume) { const p = media.play(); if (p && p.catch) p.catch(() => {}); }
    };
    mount(mode);

    const el = h('div', { class: 'player-wrap' }, slot);
    if (both) {
      const mk = (m, label) => h('button', { class: 'mode', type: 'button', 'aria-pressed': String(mode === m), onclick: () => {
        if (cur.mode === m) return;
        const at = cur.media.currentTime || 0;
        const was = !cur.media.paused;
        cur.media.pause();
        mode = m;
        try { localStorage.setItem(KEY, m); } catch { /* ignore */ }
        mount(m, at, was);
        btns.forEach(([bm, b]) => b.setAttribute('aria-pressed', String(bm === m)));
      } }, label);
      const btns = [['listen', mk('listen', 'Listen')], ['watch', mk('watch', 'Watch')]];
      el.append(h('div', { class: 'modes', role: 'group', 'aria-label': 'Listen or watch' }, btns.map((x) => x[1])));
    }
    return { el, media: () => cur.media, play: () => cur.media.play() };
  }
  const media = player.el;
  // Coming from the previous part of an album: carry on playing (if the browser blocks it, one tap does).
  if (new URLSearchParams(location.search).get('play') === '1') {
    const tryPlay = () => player.play().catch(() => { toast('Tap play to carry on with the album.'); });
    setTimeout(tryPlay, 250);
  }

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

  // Download: choose Audio or Video. The Worker sends the file with a Content-Disposition, so the browser saves it
  // under the name we give. A version that does not exist yet shows greyed out. The Studio can switch downloads off per item.
  function openDownload() {
    const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const opt = (label, key) => {
      if (!key) return h('span', { class: 'btn-go dl-opt off', 'aria-disabled': 'true' }, label, h('small', {}, 'Not available yet'));
      const name = downloadName(item.title, extOf({ key }));
      const url = data.mediaUrl(key);
      return h('a', { class: 'btn-go dl-opt', href: `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(name)}`, download: name, onclick: () => setTimeout(close, 400) },
        label, h('small', {}, extOf({ key }).toUpperCase()));
    };
    const wrap = h('div', { class: 'invite', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Download', onclick: (e) => { if (e.target === wrap) close(); } },
      h('div', { class: 'invite-box' },
        h('button', { class: 'invite-x', type: 'button', 'aria-label': 'Close', onclick: close }, '×'),
        h('h2', {}, 'Download'),
        h('div', { class: 'dl-opts' }, opt('Audio', audioKey), opt('Video', videoKey))));
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
  }
  const dlBtn = item.allow_download === false ? null
    : h('button', { class: 'react dl', type: 'button', 'aria-label': 'Download', title: 'Download', onclick: openDownload }, icon('download'));

  const titleText = h('h1', {}, item.title);
  const titleBox = h('div', { class: 'ttl' }, titleText);
  const description = (item.description || '').trim() ? descBlock(item.description.trim()) : null;

  // The album: this item is one part of a live's recap. The strip lists the parts; the album loops.
  const albumEl = parts.length ? h('section', { class: 'album', 'aria-label': 'Album' },
    h('div', { class: 'album-head' }, h('span', { class: 'album-tag' }, 'Album'), h('strong', {}, item.album_title || 'Live recap'), h('span', { class: 'muted small' }, ` · ${parts.length} part${parts.length === 1 ? '' : 's'} · plays on, then starts again`)),
    h('ol', { class: 'album-list' }, parts.map((x, i) => h('li', { class: x.id === id ? 'now' : '' },
      h('a', { href: `/poem/?id=${x.id}${x.id === id ? '' : '&play=1'}`, 'aria-current': x.id === id ? 'true' : null },
        h('span', { class: 'n' }, String(i + 1)), h('span', { class: 't' }, x.title), h('span', { class: 'muted small' }, fmtDur(x.duration))))))) : null;

  // Native replaceChildren() would print a missing item as the word "null", so only real items go in.
  root.replaceChildren(...[
    titleBox,
    media,
    albumEl,
    h('p', { class: 'meta' }, fmtAgo(item.published_at), ' · ', views),
    description ? description.el : null,
    h('div', { class: 'reacts', role: 'group', 'aria-label': 'Reactions and comments' }, [likeBtn, comBtn, dlBtn, shareBtn].filter(Boolean)),
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
