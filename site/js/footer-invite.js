// The "Create account" block in the footer of the public pages: what an account gives, and a button.
// It shows only to people who are not signed in (a guest counts as not signed in), and it stays hidden until
// the page knows who is looking, so a member never sees it flash.
import { h } from '../shared/dom.js';
import { sbp } from '../shared/supabase-public.js';

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
  foot.prepend(box);
  const paint = (session) => { box.hidden = !!(session && !session.user.is_anonymous); };
  sbp.auth.getSession().then(({ data }) => paint(data.session), () => paint(null));
  sbp.auth.onAuthStateChange((_event, session) => paint(session));
}
