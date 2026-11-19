// The laptop home page: five cards (Studio, Poems, Live, Settings, Performance) and a strip of headline numbers.
// On a phone the bottom tabs are used instead, so this page is for the laptop.
import { h, tabIcon } from './ui.js';
import { loadStats, summarize } from './stats-data.js';

const CARDS = [
  ['studio', 'Studio', 'Bake audio and video, upload and publish your posts.'],
  ['poems', 'Poems', 'Write your poems, record them and add a background tune.'],
  ['live', 'Live', 'Go on air, and open old lives and their recaps.'],
  ['settings', 'Settings', 'Sync, storage and your audio folders.'],
  ['performance', 'Performance', 'How your lives and posts are doing.'],
];

export async function homeView(go) {
  const tile = (label) => { const v = h('b', {}, '–'); const sub = h('span', { class: 'muted small' }); return { v, sub, el: h('div', { class: 'home-tile' }, h('span', { class: 'muted small' }, label), v, sub) }; };
  const tViews = tile('Total views'); const tPosts = tile('Posts'); const tLives = tile('Lives'); const tTop = tile('Most watched live');
  const strip = h('div', { class: 'home-strip' }, tViews.el, tPosts.el, tLives.el, tTop.el);
  const grid = h('div', { class: 'home-grid' }, CARDS.map(([k, label, text]) =>
    h('button', { class: 'home-card', type: 'button', onclick: () => go(k) }, h('span', { class: 'home-ic' }, tabIcon(k, 26)), h('b', {}, label), h('span', { class: 'muted' }, text))));
  const el = h('section', { class: 'view home' }, h('div', { class: 'toolbar' }, h('h2', {}, 'Home')), strip, grid);

  loadStats().then((d) => {
    const s = summarize(d);
    tViews.v.textContent = String(s.totalViews);
    tPosts.v.textContent = String(s.postCount);
    tLives.v.textContent = String(s.liveCount);
    if (s.mostWatched) { tTop.v.textContent = String(s.mostWatched.views); tTop.sub.textContent = s.mostWatched.title; } else tTop.sub.textContent = 'No lives yet';
  }, (e) => { tViews.sub.textContent = e.message || 'Numbers not available'; });
  return el;
}
