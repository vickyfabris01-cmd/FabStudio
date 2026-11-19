// The invitation to create an account, shown on the poem page after a poem has been played to its end.
// Only to people without an account (guests count as "no account"). If it is closed it does not come back for 3 days.
import { h } from '../shared/dom.js';
import { isMember } from './auth-ui.js';

const KEY = 'fp.invite.next';
const DAYS = 3;
let open = false;

export function maybeInvite() {
  if (open || isMember()) return;
  let next = 0;
  try { next = Number(localStorage.getItem(KEY) || 0); } catch { /* storage blocked: ask once per page */ }
  if (Date.now() < next) return;
  try { localStorage.setItem(KEY, String(Date.now() + DAYS * 86400000)); } catch { /* ignore */ }
  show();
}

function show() {
  open = true;
  const back = location.pathname + location.search;
  const close = () => { open = false; document.removeEventListener('keydown', onKey); wrap.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const wrap = h('div', { class: 'invite', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Create an account', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'invite-box' },
      h('button', { class: 'invite-x', type: 'button', 'aria-label': 'Close', onclick: close }, '×'),
      h('h2', {}, 'Enjoying the poems?'),
      h('p', {}, 'Create a free account to react, comment, join the live chat and keep your place. Everything you did as a guest comes with you.'),
      h('div', { class: 'invite-go' },
        h('a', { class: 'btn-go', href: `/auth/signup/?next=${encodeURIComponent(back)}` }, 'Create account'),
        h('button', { class: 'btn-later', type: 'button', onclick: close }, 'Maybe later'))));
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  wrap.querySelector('.btn-go').focus();
}
