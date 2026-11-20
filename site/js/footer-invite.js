// The "Create account" block in the footer of the public pages: what an account gives, and a button.
// It shows only to people who are not signed in (a guest counts as not signed in), and it stays hidden until
// the page knows who is looking, so a member never sees it flash.
// Below it, an "Install app" row appears when this browser can install the site.
import { h } from '../shared/dom.js';
import { sbp } from '../shared/supabase-public.js';
import { installMode, promptInstall, onInstallChange } from './pwa.js';

const foot = document.querySelector('footer.foot');
if (foot) {
  const back = location.pathname + location.search;
  const box = h('div', { class: 'foot-invite', hidden: true },
    h('b', {}, 'Create a free account'),
    h('ul', {},
      h('li', {}, 'React, comment and join the live chat'),
      h('li', {}, 'Your reactions and comments follow you to any device'),
      h('li', {}, 'Everything you did as a guest moves to your account')),
    h('a', { class: 'btn-go', href: `/auth/signup/?next=${encodeURIComponent(back)}` }, 'Create account'),
    h('a', { class: 'foot-signin', href: `/auth/?next=${encodeURIComponent(back)}` }, 'Already have one? Sign in'));
  // Install: a real prompt where the browser has one, the "Add to Home Screen" steps on iPhone and iPad.
  const steps = () => {
    const close = () => { document.removeEventListener('keydown', onKey); wrap.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const wrap = h('div', { class: 'invite', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Install Fabris Poet', onclick: (e) => { if (e.target === wrap) close(); } },
      h('div', { class: 'invite-box' },
        h('button', { class: 'invite-x', type: 'button', 'aria-label': 'Close', onclick: close }, '×'),
        h('h2', {}, 'Install Fabris Poet'),
        h('ol', { class: 'ios-steps' },
          h('li', {}, 'Tap the Share button in your browser (the square with an arrow).'),
          h('li', {}, 'Scroll down and tap Add to Home Screen.'),
          h('li', {}, 'Tap Add. Fabris Poet now opens like an app.')),
        h('div', { class: 'invite-go' }, h('button', { class: 'btn-go', type: 'button', onclick: close }, 'Got it'))));
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
  };
  const install = h('div', { class: 'foot-install', hidden: true },
    h('span', {}, 'Get Fabris Poet as an app on this device'),
    h('button', { class: 'btn-go', type: 'button', onclick: async () => { if (installMode() === 'ios') steps(); else await promptInstall(); } }, 'Install app'));
  const paintInstall = () => { install.hidden = !installMode(); };
  onInstallChange(paintInstall);
  paintInstall();
  foot.prepend(install);
  foot.prepend(box);
  const paint = (session) => { box.hidden = !!(session && !session.user.is_anonymous); };
  sbp.auth.getSession().then(({ data }) => paint(data.session), () => paint(null));
  sbp.auth.onAuthStateChange((_event, session) => paint(session));
}
