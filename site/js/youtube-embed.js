// YouTube on the public site. Two small pieces, both opt-in for the viewer:
//   liveVideo()     the "Watch video" button and player on the live page. It only exists while the host has switched
//                   the video on, and the YouTube player is not loaded until a viewer taps. The audio code of the live
//                   page is not changed: opening the video just uses the page's own pause, closing it lets it resume.
//   youtubePlayer() the player of a post that comes from YouTube (the post page).
import { h } from '../shared/dom.js';
import { isYouTubeId } from '../shared/youtube-id.js';

const CSS = `
.l-video{margin:.5rem 0 0}
.l-video[hidden]{display:none}
.l-frame{position:relative;width:min(100%,calc(38dvh * 16 / 9));aspect-ratio:16/9;margin:0 auto;background:#000;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.l-frame iframe,.yt-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.l-vbar{display:flex;align-items:center;gap:.6rem;margin-top:.4rem}
.l-vbar .l-meta{flex:1;font-size:.82rem}
.l-stage.video-on .l-over,.l-stage.video-on .l-ctl,.l-stage.video-on>img{display:none}
.l-stage.video-on{min-height:0}
.l-stage.video-on .l-stagebody{padding-bottom:.5rem}
.yt-wrap{margin-top:.8rem}
.yt-frame{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden}
.yt-facade{display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:0;border:0;cursor:pointer;background:#000 center/cover no-repeat;color:#fff}
.yt-facade .yt-go{width:68px;height:68px;border-radius:50%;background:rgba(20,18,26,.72);border:2px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center}
.yt-facade svg{width:30px;height:30px;fill:currentColor}
.yt-note{margin:.4rem 0 0;font-size:.82rem;color:var(--muted)}
`;
const style = document.createElement('style');
style.textContent = CSS;
document.head.append(style);

const VIDEO = '<path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4z"/><path d="M3 6m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z"/>';
const PLAY = '<path d="M7 4v16l13 -8z"/>';
const icon = (d) => { const s = h('span'); s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`; return s.firstChild; };

const embedUrl = (id) => `https://www.youtube.com/embed/${id}?${new URLSearchParams({ autoplay: '1', playsinline: '1', rel: '0', modestbranding: '1' })}`;
const frame = (id, title) => h('iframe', {
  src: embedUrl(id), title, allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true,
  referrerpolicy: 'strict-origin-when-cross-origin',
});

/* ---------- the live page ---------- */
// stage: the live card (it is tidied while the video plays). onOpen / onClose: what the page does with its own audio.
export function liveVideo({ stage, onOpen, onClose }) {
  const btn = h('button', { class: 'l-pill', type: 'button', hidden: true, title: 'Video uses much more data than audio' }, icon(VIDEO), h('span', {}, 'Watch video'));
  const bar = h('div', { class: 'l-vbar' }, h('span', { class: 'l-meta' }, 'Video uses much more data than audio.'), h('button', { class: 'l-link', type: 'button' }, 'Back to audio only'));
  const box = h('div', { class: 'l-video', hidden: true });
  let open = false; let shownId = '';

  const close = (notify = true) => {
    if (!open) return;
    open = false; shownId = '';
    box.replaceChildren(); box.hidden = true;
    stage?.classList.remove('video-on');
    if (notify) onClose?.();
  };
  const show = (id, title) => {
    open = true; shownId = id;
    box.replaceChildren(h('div', { class: 'l-frame' }, frame(id, title)), bar);
    box.hidden = false;
    stage?.classList.add('video-on');
  };
  btn.onclick = () => {
    const id = btn.dataset.id;
    if (!isYouTubeId(id)) return;
    if (navigator.connection?.saveData && !confirm('Data saver is on, and video uses a lot of data. Watch anyway?')) return;
    onOpen?.();
    show(id, btn.dataset.title || 'Live video');
  };
  bar.querySelector('button').onclick = () => close();

  // Called with every repaint of the page (once a second): cheap, and only touches the player when something changed.
  const paint = ({ live, blocked, settings, title }) => {
    const id = settings?.ytShow && isYouTubeId(settings?.ytVideoId) ? settings.ytVideoId : '';
    const available = !!id && !!live && !blocked;
    btn.hidden = !available;
    btn.dataset.id = id; btn.dataset.title = title ? `${title} (video)` : 'Live video';
    if (open && (!available || id !== shownId)) {
      close(true);                                   // the host hid the video, or the live ended: back to the audio
      if (available && id) { /* a new video id: the viewer taps Watch video again */ }
    }
  };
  return { btn, box, paint, close, isOpen: () => open };
}

/* ---------- a post that comes from YouTube ---------- */
// item: a row of items_public. isMember / requireAuth: the page's sign-in helpers (playing needs an account, as for any post).
export function youtubePlayer(item, { thumbUrl = '', isMember, requireAuth }) {
  const slot = h('div', { class: 'yt-frame' });
  const start = () => slot.replaceChildren(frame(item.youtube_id, item.title || 'Video'));
  const go = h('button', { class: 'yt-facade', type: 'button', 'aria-label': `Play ${item.title || 'video'}`, style: thumbUrl ? `background-image:url("${thumbUrl}")` : null },
    h('span', { class: 'yt-go' }, icon(PLAY)));
  go.onclick = () => {
    if (isMember()) return start();
    requireAuth('watch').then((s) => { if (s) start(); });
  };
  slot.append(go);
  const el = h('div', { class: 'yt-wrap player-wrap' }, slot, h('p', { class: 'yt-note' }, 'Plays from YouTube. Video uses more data than audio.'));
  return { el, media: () => null, play: () => Promise.resolve() };
}
