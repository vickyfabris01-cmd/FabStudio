// The four stat cards: Views, Watching, Love, Like (about 56 px high). +1 floats up on a new view or watcher,
// and -1 floats away when someone leaves. All counts are for this live.
import { h, eyeIcon, loveIcon, likeIcon } from '../ui.js';

export function statCards(engine) {
  const mk = (icon, label) => {
    const v = h('b', { class: 'stat-v' }, '–');
    return { v, el: h('div', { class: 'stat' }, h('div', { class: 'stat-l' }, icon, h('span', {}, label)), v) };
  };
  const views = mk(eyeIcon(14), 'Views'); const watching = mk(null, 'Watching');
  const love = mk(loveIcon(14), 'Love'); const like = mk(likeIcon(14), 'Like');
  love.el.classList.add('is-love');
  const el = h('div', { class: 'c-stats' }, views.el, watching.el, love.el, like.el);
  let pv = null; let pw = null;

  const float = (card, diff) => {
    if (!diff || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const f = h('span', { class: 'stat-fl ' + (diff > 0 ? 'up' : 'down') }, `${diff > 0 ? '+' : '-'}${Math.min(9, Math.abs(diff))}`);
    card.append(f);
    setTimeout(() => f.remove(), 1500);
  };

  function paint() {
    const s = engine.s;
    views.v.textContent = String(s.views);
    watching.v.textContent = s.watching == null ? '–' : String(s.watching);
    love.v.textContent = String(s.love);
    like.v.textContent = String(s.pulses.like);
    if (pv != null) float(views.el, s.views - pv);
    if (pw != null && s.watching != null) float(watching.el, s.watching - pw);
    pv = s.views; pw = s.watching == null ? pw : s.watching;
  }
  return { el, paint };
}
