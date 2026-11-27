// Fabris Poet home page: an invitation hero, a filter, and the published items as 16:9 cards.
//  - Hero: a background picture that changes every day (up to 7, uploaded in the Studio), what the site offers, and the
//    live (now or next) when there is one. People without an account also see one quiet line inviting them to join.
//  - Filter: (when both exist) All formats / Audio / Video.
//  - Cards: exactly 16:9. They show at a glance whether it is audio or video, how long it is, and read-only counts.
//    Reacting happens on the item page.
import { h } from '../shared/dom.js';
import { initAuth, mountAccountChip, isMember, onAuth } from './auth-ui.js';
import { listItems, listHero, mediaUrl, friendly, nextLive } from './data.js';

const NS = 'http://www.w3.org/2000/svg';
const ic = (inner, fill) => {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true');
  if (fill) s.setAttribute('data-fill', '1');
  s.innerHTML = inner;
  return s;
};
const ICONS = {
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  like: '<path d="M7 11v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3a4 4 0 0 0 4-4V5a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 2 0 0 1-2 2h-7a3 3 0 0 1-3-3"/>',
  comment: '<path d="M3 20l1.3-3.9a9 8 0 1 1 3.4 2.9l-4.7 1"/>',
  audio: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><path d="M4 15h3v5H5a1 1 0 0 1-1-1v-4zM20 15h-3v5h2a1 1 0 0 0 1-1v-4z"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
};

const clock = (s) => { s = Math.round(Number(s) || 0); if (!s) return ''; const m = Math.floor(s / 60); const r = s % 60; return `${m}:${String(r).padStart(2, '0')}`; };
const isVideo = (it) => it.kind === 'video' || /^video\//.test(it.mime || '');

function card(it) {
  const video = isVideo(it);
  const title = it.title || 'Untitled';
  const thumb = it.public_thumb_key ? mediaUrl(it.public_thumb_key) : '';
  // A drawn title card already shows the title; a picture of your own gets the title added.
  const showTitle = it.thumb_kind !== 'title' && it.thumb_kind !== 'scene';
  const len = clock(it.duration);
  return h('a', { class: 'pcard ' + (video ? 'is-video' : 'is-audio'), href: `/poem/?id=${it.id}`, 'aria-label': `${title}. ${video ? 'Video' : 'Audio'}${len ? ', ' + len : ''}` },
    thumb ? h('img', { class: 'pc-img', src: thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'pc-img ph' }),
    h('span', { class: 'pc-type' }, ic(video ? ICONS.video : ICONS.audio), video ? 'Video' : 'Audio', len ? h('span', { class: 'pc-len' }, ` · ${len}`) : null),
    video ? h('span', { class: 'pc-play', 'aria-hidden': 'true' }, ic(ICONS.play, true)) : null,
    h('div', { class: 'pc-bar' },
      showTitle ? h('div', { class: 'pc-title' }, title) : null,
      h('div', { class: 'pc-stats' },
        h('span', { title: 'Views' }, ic(ICONS.eye), String(it.n_views ?? 0)),
        h('span', { title: 'Likes' }, ic(ICONS.like), String(it.n_like ?? 0)),
        h('span', { title: 'Comments' }, ic(ICONS.comment), String(it.n_comments ?? 0)))));
}

// The hero picture of the day: every visitor sees the same one, and it changes at midnight in Nairobi.
function pictureOfTheDay(list) {
  if (!list.length) return null;
  const day = Math.floor((Date.now() + 3 * 3600 * 1000) / 86400000);
  return list[day % list.length];
}

function buildHero(pics) {
  const hero = document.getElementById('hero');
  const pic = pictureOfTheDay(pics);
  if (pic) {
    const img = h('img', { class: 'hero-bg', src: mediaUrl(pic.key), alt: '', fetchpriority: 'high', decoding: 'async' });
    img.onload = () => img.classList.add('on');
    hero.classList.add('has-bg');
    hero.prepend(img, h('div', { class: 'hero-shade' }));
  }
}

function buildHeroActions() {
  const inner = document.querySelector('#hero .hero-in');
  const cta = h('div', { class: 'hero-cta' });
  const invite = h('a', { class: 'hero-invite', href: `/auth/signup/?next=${encodeURIComponent(location.pathname + location.search)}` }, 'Create an account to explore more →');
  const paintInvite = () => { invite.hidden = isMember(); };
  paintInvite(); onAuth(paintInvite);
  inner.append(cta, invite);
  // the live (now, or next), as a button in the hero
  nextLive().then((l) => {
    if (!l) return;
    const on = l.state === 'live';
    cta.append(h('a', { class: 'hero-live' + (on ? ' on' : ''), href: `/live/?id=${l.id}` },
      on ? '● Live now · Join' : `Next live · ${l.starts_at ? new Date(l.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : l.title}`));
  }).catch(() => {});
}

function buildFilters(items, onChange) {
  const box = document.getElementById('filters');
  const state = { fmt: 'all' };
  const hasVideo = items.some(isVideo); const hasAudio = items.some((i) => !isVideo(i));
  const fmts = hasVideo && hasAudio ? [['all', 'All formats'], ['audio', 'Audio'], ['video', 'Video']] : [];
  if (!fmts.length) return state;
  const chip = (k, label) => h('button', { class: 'fchip', type: 'button', 'aria-pressed': String(state.fmt === k), onclick: () => { state.fmt = k; paint(); onChange(); } }, label);
  function paint() {
    box.replaceChildren(h('div', { class: 'frow fmt' }, ...fmts.map(([k, l]) => chip(k, l))));
    box.hidden = false;
  }
  paint();
  return state;
}

async function main() {
  mountAccountChip(document.getElementById('account'));
  initAuth();
  const grid = document.getElementById('grid');
  buildHeroActions();
  listHero().then(buildHero, () => {});
  try {
    const items = await listItems();
    const draw = () => {
      const rows = items.filter((it) => f.fmt === 'all' || (f.fmt === 'video' ? isVideo(it) : !isVideo(it)));
      grid.replaceChildren(...(rows.length ? rows.map(card) : [h('p', { class: 'empty' }, items.length ? 'Nothing here yet.' : 'The first poem is on its way.')]));
    };
    const f = buildFilters(items, draw);
    draw();
  } catch (e) {
    grid.replaceChildren(h('p', { class: 'empty' }, 'Could not load poems. ' + friendly(e)));
  }
}
main();
