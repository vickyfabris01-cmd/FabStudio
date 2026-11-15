// Fabris Poet home page: the latest published poems, each as a thumbnail, a name and a date.
import { h, fmtDate } from '../shared/dom.js';
import { initAuth, mountAccountChip } from './auth-ui.js';
import { listItems, mediaUrl, friendly, nextLive } from './data.js';

function card(it) {
  return h('a', { class: 'card', href: `/poem/?id=${it.id}` },
    it.public_thumb_key
      ? h('img', { class: 'cover', src: mediaUrl(it.public_thumb_key), alt: '', loading: 'lazy' })
      : h('div', { class: 'cover ph' }),
    h('div', { class: 'card-body' },
      h('h3', {}, it.title || 'Untitled'),
      h('p', { class: 'meta' }, fmtDate(it.published_at))));
}

async function main() {
  mountAccountChip(document.getElementById('account'));
  initAuth();
  const grid = document.getElementById('grid');
  nextLive().then((l) => {
    if (!l) return;
    const on = l.state === 'live';
    grid.before(h('a', { class: 'card', href: `/live/?id=${l.id}`, style: 'display:block;padding:.9rem 1rem;margin-bottom:1rem;border:1px solid ' + (on ? 'var(--danger)' : 'var(--line)') },
      h('b', {}, on ? '● Live now: ' : 'Upcoming live: '), l.title, l.starts_at && !on ? ` · ${new Date(l.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''));
  }).catch(() => {});
  try {
    const items = await listItems();
    grid.replaceChildren(...(items.length ? items.map(card) : [h('p', { class: 'empty' }, 'The first poem is on its way.')]));
  } catch (e) {
    grid.replaceChildren(h('p', { class: 'empty' }, 'Could not load poems. ' + friendly(e)));
  }
}
main();
