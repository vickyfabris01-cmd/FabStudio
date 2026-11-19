// The Performance page: tabs Overall, Lives and Posts. Only numbers that are saved are shown (see stats-data.js).
import { h } from './ui.js';
import { loadStats, summarize, fmtLiveTime } from './stats-data.js';

export async function performanceView(nav) {
  const body = h('div', { class: 'perf-body' }, h('p', { class: 'muted' }, 'Loading the numbers…'));
  const names = [['overall', 'Overall'], ['lives', 'Lives'], ['posts', 'Posts']];
  const tabs = h('div', { class: 'row c-tabs perf-tabs' });
  const el = h('section', { class: 'view perf' }, h('div', { class: 'toolbar' }, h('h2', {}, 'Performance')), tabs, body);
  let data = null; let tab = 'overall';

  const stat = (label, value, sub) => h('div', { class: 'home-tile' }, h('span', { class: 'muted small' }, label), h('b', {}, value == null ? '–' : String(value)), sub ? h('span', { class: 'muted small' }, sub) : null);
  const rank = (title, list, f, unit, open) => h('div', { class: 'perf-col card' }, h('h3', {}, title),
    list.length ? h('ol', { class: 'perf-list' }, list.map((x) => h('li', {}, h('button', { class: 'perf-row', type: 'button', onclick: () => open(x.id) }, h('span', { class: 'grow perf-t' }, x.title), h('b', {}, String(f(x))), h('span', { class: 'muted small' }, ' ' + unit)))))
      : h('p', { class: 'muted small' }, 'Nothing yet.'));

  function paint() {
    tabs.replaceChildren(...names.map(([k, l]) => h('button', { class: 'tab' + (k === tab ? ' on' : ''), type: 'button', onclick: () => { tab = k; paint(); } }, l)));
    if (!data) return;
    const s = summarize(data);
    const openLive = (id) => nav.openLive(id); const openPost = (id) => nav.open(id);
    if (tab === 'overall') {
      body.replaceChildren(h('div', { class: 'perf-tiles' },
        stat('Views, posts', s.postViews), stat('Views, lives', s.liveViews), stat('Likes, posts', s.likes), stat('Comments, posts', s.comments),
        stat('Posts', s.postCount), stat('Lives', s.liveCount), stat('Total live time', s.liveMinutes ? fmtLiveTime(s.liveMinutes) : null),
        stat('Highest peak watching', s.highestPeak || null), stat('Love on lives', s.liveLove), stat('Chat messages in lives', s.liveChats)),
      h('p', { class: 'muted small' }, 'Love on posts is no longer counted. Figures come from what is saved online.'));
    } else if (tab === 'lives') {
      body.replaceChildren(h('div', { class: 'perf-cols' },
        rank('Most watched', s.rank.liveViews, (l) => l.views, 'views', openLive),
        rank('Highest peak', s.rank.livePeak, (l) => l.peak, 'watching', openLive),
        rank('Most loved', s.rank.liveLove, (l) => l.love, 'love', openLive)));
    } else {
      body.replaceChildren(h('div', { class: 'perf-cols' },
        rank('Most viewed', s.rank.postViews, (p) => p.views, 'views', openPost),
        rank('Most liked', s.rank.postLikes, (p) => p.likes, 'likes', openPost),
        rank('Most commented', s.rank.postComments, (p) => p.comments, 'comments', openPost)));
    }
  }
  paint();
  loadStats().then((d) => { data = d; paint(); }, (e) => { body.replaceChildren(h('p', { class: 'error' }, (e.message || String(e)) + (navigator.onLine ? ' Did you run migration 007_live_log.sql?' : ''))); });
  return el;
}
