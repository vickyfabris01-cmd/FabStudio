// YouTube in FabStudio. Read only, and nothing here touches the audio live.
//   - youtubeButton / openYouTubeLibrary: your channel's uploads, shown on the Studio page. Publish puts one on
//     Fabris Poet as a post that plays from YouTube.
//   - liveCheckRow: the "Check YouTube live" button on the ready card before a live. YouTube is only asked when
//     the button is pressed (one request), never in the background.
import { CONFIG } from '../../shared/config.js';
import { getToken } from './auth.js';
import { syncAndWait } from './sync.js';
import { h, toast, openModal, fmtDur } from './ui.js';

/* ---------- talking to the Worker ---------- */
async function yt(path, { method = 'GET', json } = {}) {
  if (!navigator.onLine) throw new Error('This needs internet.');
  const token = await getToken();
  if (!token) throw new Error('Sign in again in Settings, then try again.');
  const res = await fetch(CONFIG.API_BASE + path, {
    method, headers: { Authorization: 'Bearer ' + token, ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Something went wrong (${res.status}).`); e.status = res.status; throw e; }
  return data;
}
export const ytStatus = () => yt('/youtube/status');
export const ytLive = () => yt('/youtube/live');
export const ytVideos = (page) => yt('/youtube/videos' + (page ? `?page=${encodeURIComponent(page)}` : ''));
export const ytPublish = (videoId) => yt('/youtube/publish', { method: 'POST', json: { videoId } });
export const ytDisconnect = () => yt('/youtube/disconnect', { method: 'POST' });
export async function connectYouTube() {
  try {
    const { url } = await yt('/youtube/connect', { method: 'POST', json: { return: `${location.origin}/studio/` } });
    location.href = url;
  } catch (e) { toast(e.message || 'Could not start the YouTube sign-in.'); }
}
export const publicUrl = (key) => (key ? `${CONFIG.API_BASE}/public/${key}` : '');

/* ---------- coming back from Google ---------- */
(() => {
  const p = new URLSearchParams(location.search);
  const flag = p.get('yt');
  if (!flag) return;
  p.delete('yt');
  history.replaceState(null, '', location.pathname + (p.toString() ? `?${p}` : '') + location.hash);
  const MSG = {
    connected: 'YouTube is connected.', denied: 'YouTube was not connected: access was not allowed.',
    nochannel: 'That Google account has no YouTube channel.', error: 'YouTube could not be connected. Try again.',
  };
  setTimeout(() => toast(MSG[flag] || MSG.error), 900);
})();

/* ---------- small styles (kept here so no other file has to change) ---------- */
const CSS = `
.yt-row .thumb{width:84px;height:47px}
.yt-list{max-height:52dvh;overflow:auto}
.yt-check{display:grid;gap:.5rem}
.yt-found{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.yt-found img{width:84px;height:47px;object-fit:cover;border-radius:6px;background:var(--line);flex:none}
.yt-found .grow{min-width:0}
.yt-state{align-items:center;gap:.6rem}
`;
const style = document.createElement('style');
style.textContent = CSS;
document.head.append(style);

/* ---------- the library (Studio page) ---------- */
const PRIVACY = { public: 'Public', unlisted: 'Unlisted', private: 'Private' };

export function youtubeButton(onChange) {
  return h('button', { class: 'btn', type: 'button', onclick: () => openYouTubeLibrary({ onChange }) }, 'YouTube');
}

export function openYouTubeLibrary({ onChange } = {}) {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const done = h('button', { class: 'btn', type: 'button' }, 'Close');
  const { close, box } = openModal(
    h('h3', {}, 'YouTube videos'),
    h('p', { class: 'muted small' }, 'Pick a video from your channel to show on Fabris Poet. It plays from YouTube. Its views, Like and comments are counted on your site, separate from YouTube\'s own numbers.'),
    body, h('div', { class: 'row', style: 'justify-content:flex-end' }, done));
  box.classList.add('wide');
  done.onclick = () => close();

  const rowFor = (v) => {
    const why = v.itemId ? '' : v.privacy === 'private' ? 'Private on YouTube. Make it Unlisted or Public to add it.'
      : !v.embeddable ? 'Embedding is off. Turn on "Allow embedding" in YouTube Studio.'
        : v.live && v.live !== 'none' ? 'This live has not finished yet.' : '';
    const btn = h('button', { class: 'btn small' + (v.itemId || why ? '' : ' primary'), type: 'button' }, v.itemId ? 'On the site' : 'Publish');
    btn.disabled = !!v.itemId || !!why;
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Publishing…';
      try {
        await ytPublish(v.id);
        btn.textContent = 'On the site';
        toast(`Published: ${v.title}`);
        await syncAndWait().catch(() => {});   // brings the new post into the Studio list
        onChange?.();
      } catch (e) { toast(e.message || 'Could not publish.'); btn.disabled = false; btn.textContent = 'Publish'; }
    };
    return h('li', { class: 'item yt-row' },
      h('img', { class: 'thumb', src: v.thumb || null, alt: '', loading: 'lazy' }),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, v.title || 'Untitled'),
        h('div', { class: 'sub' }, [v.seconds ? fmtDur(v.seconds) : '', PRIVACY[v.privacy] || v.privacy].filter(Boolean).join(' · ')),
        why ? h('div', { class: 'sub error' }, why) : null),
      btn);
  };

  async function showList(channelTitle) {
    const list = h('ul', { class: 'list yt-list' });
    const more = h('button', { class: 'btn', type: 'button', hidden: true }, 'Load more');
    const note = h('p', { class: 'small muted' });
    const off = h('button', { class: 'btn small', type: 'button' }, 'Disconnect');
    off.onclick = async () => {
      if (!confirm('Disconnect YouTube? Posts already on the site stay as they are.')) return;
      try { await ytDisconnect(); toast('YouTube disconnected.'); load(); } catch (e) { toast(e.message || 'Could not disconnect.'); }
    };
    body.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'grow small muted' }, channelTitle ? `Channel: ${channelTitle}` : ''), off), list, note, more);
    let next = null; let busy = false;
    const page = async () => {
      if (busy) return;
      busy = true; more.disabled = true; note.className = 'small muted'; note.textContent = 'Loading…';
      try {
        const d = await ytVideos(next);
        next = d.next;
        for (const v of d.items) list.append(rowFor(v));
        note.textContent = list.children.length ? '' : 'No uploads found on this channel yet.';
      } catch (e) { note.className = 'small error'; note.textContent = e.message || 'Could not load your videos.'; }
      busy = false; more.disabled = false; more.hidden = !next;
    };
    more.onclick = page;
    await page();
  }

  async function load() {
    body.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    let st;
    try { st = await ytStatus(); } catch (e) { body.replaceChildren(h('p', { class: 'error' }, e.message || 'Could not reach the server.')); return; }
    if (!st.configured) { body.replaceChildren(h('p', { class: 'error' }, 'YouTube is not set up on the Worker yet. Follow docs/YOUTUBE-UPDATE.md, then come back.')); return; }
    if (!st.connected) {
      body.replaceChildren(
        h('p', {}, 'Connect your YouTube channel once. FabStudio gets read access only: it can see your videos and cannot change or delete anything on YouTube.'),
        h('button', { class: 'btn primary', type: 'button', onclick: connectYouTube }, 'Connect YouTube'));
      return;
    }
    await showList(st.channelTitle);
  }
  load();
}

/* ---------- the "Check YouTube live" row (the ready card, before going live) ---------- */
// settings(): the live's current settings. save(patch): saves some of them (they reach viewers at once).
export function liveCheckRow({ settings, save }) {
  const btn = h('button', { class: 'btn small', type: 'button' }, 'Check YouTube live');
  const out = h('div', { class: 'yt-check' });
  const el = h('div', { class: 'yt-check' }, h('div', { class: 'row' }, h('b', {}, 'YouTube video'), h('span', { class: 'grow' }), btn), out);
  let last = null; let busy = false; let shown = '';
  const apply = async (patch) => { try { await save(patch); } catch (e) { toast(e.message || 'Could not save.'); } };

  const paint = () => {
    const s = settings() || {};
    const k = JSON.stringify([s.ytVideoId, !!s.ytShow, last]);
    if (k === shown) return;
    shown = k;
    const kids = [];
    if (s.ytVideoId) {
      kids.push(h('div', { class: 'row yt-state' },
        h('span', { class: 'grow small' }, s.ytShow ? `Viewers can open the video (youtu.be/${s.ytVideoId}).` : `Video set (youtu.be/${s.ytVideoId}) but hidden from viewers.`),
        h('button', { class: 'btn small', type: 'button', onclick: () => apply({ ytShow: !s.ytShow }) }, s.ytShow ? 'Hide from viewers' : 'Show to viewers')));
    }
    if (last?.error) kids.push(h('p', { class: 'small error' }, last.error));
    else if (last?.needConnect) kids.push(h('div', { class: 'row yt-state' }, h('span', { class: 'grow small muted' }, 'YouTube is not connected yet.'), h('button', { class: 'btn small primary', type: 'button', onclick: connectYouTube }, 'Connect YouTube')));
    else if (last?.none) kids.push(h('p', { class: 'small muted' }, 'No live found on your channel yet. Start the stream on your phone, then check again.'));
    else if (last?.videoId && !(s.ytShow && s.ytVideoId === last.videoId)) {
      const blocked = !last.embeddable;
      const show = h('button', { class: 'btn small primary', type: 'button', onclick: () => apply({ ytVideoId: last.videoId, ytShow: true }) }, 'Show on public live page');
      show.disabled = blocked;
      kids.push(h('div', { class: 'yt-found' },
        h('img', { src: last.thumb || null, alt: '' }),
        h('div', { class: 'grow' }, h('b', {}, last.title || 'Your YouTube live'), h('div', { class: 'small muted' }, `${PRIVACY[last.privacy] || last.privacy} · live now`),
          blocked ? h('div', { class: 'small error' }, last.privacy === 'private' ? 'This live is Private, so viewers cannot play it here.' : 'Embedding is off for this live. Turn on "Allow embedding" in YouTube Studio.') : null),
        show));
    }
    out.replaceChildren(...kids);
  };

  btn.onclick = async () => {
    if (busy) return;
    busy = true; btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const d = await ytLive();
      last = !d.connected ? { needConnect: true } : d.live ? { ...d.live } : { none: true };
    } catch (e) { last = { error: e.status === 501 ? 'YouTube is not set up on the Worker yet. See docs/YOUTUBE-UPDATE.md.' : (e.message || 'Could not check YouTube.') }; }
    btn.textContent = 'Check YouTube live';
    setTimeout(() => { busy = false; btn.disabled = false; }, 4000);   // a short pause, so a double tap is only one request
    shown = ''; paint();
  };
  paint();
  return { el, paint };
}
