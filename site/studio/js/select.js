// Select mode for the Studio and Live lists. "Select" turns on ticking; once one or more are ticked a Delete button
// appears. (Each card also has a three-dot menu with its own Delete.)
import { h } from './ui.js';

export const createSelection = () => ({ on: false, ids: new Set() });

// onMode: called when select mode is switched on or off (the list is drawn again with or without tick boxes).
// onDelete: called when Delete (n) is pressed.
export function selectBar(sel, { onMode, onDelete }) {
  const el = h('div', { class: 'row selbar' });
  const paint = () => {
    const n = sel.ids.size;
    el.replaceChildren(...(sel.on
      ? [h('span', { class: 'grow small' }, n ? `${n} selected` : 'Tap cards to select them'),
        n ? h('button', { class: 'btn small danger', type: 'button', onclick: onDelete }, `Delete (${n})`) : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => { sel.on = false; sel.ids.clear(); onMode(); } }, 'Cancel')]
      : [h('span', { class: 'grow' }), h('button', { class: 'btn small', type: 'button', onclick: () => { sel.on = true; onMode(); } }, 'Select')]).filter(Boolean));
  };
  paint();
  return { el, paint };
}

// A tick box that follows the selection. Clicks are handled by the card, so the box itself ignores them.
export const tickBox = (checked) => h('input', { type: 'checkbox', class: 'selbox', checked, tabindex: '-1', 'aria-label': 'Select' });
