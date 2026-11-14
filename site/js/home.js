// Fabris Poet home page: the latest published poems.
import { h, fmtDur, fmtDate } from '../shared/dom.js';
import { initAuth, mountAccountChip } from './auth-ui.js';
import { listItems, mediaUrl, friendly } from './data.js';

const KIND = { audio: 'Audio', video: 'Video', live: 'Live replay' };

function card(it) {
  return h('a', { class: 'card', href: `/poem/?id=${it.id}` },
    it.public_thumb_key
      ? h('img', { class: 'cover', src: mediaUrl(it.public_thumb_key), alt: '', loading: 'lazy' })
      : h('div', { class: 'cover ph' }),
    h('div', { class: 'card-body' },
      h('h3', {}, it.title || 'Untitled'),
      h('p', { class: 'meta' }, `${KIND[it.kind] || it.kind}, ${fmtDur(it.duration)}, ${fmtDate(it.published_at)}`),
      h('p', { class: 'counts' }, `${it.n_plays} plays, ${it.n_reactions} reactions, ${it.n_comments} comments`)));
}

async function main() {
  mountAccountChip(document.getElementById('account'));
  initAuth();
  const grid = document.getElementById('grid');
  try {
    const items = await listItems();
    grid.replaceChildren(...(items.length ? items.map(card) : [h('p', { class: 'empty' }, 'The first poem is on its way.')]));
  } catch (e) {
    grid.replaceChildren(h('p', { class: 'empty' }, 'Could not load poems. ' + friendly(e)));
  }
}
main();
