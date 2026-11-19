// The numbers behind the Home strip and the Performance page. Everything comes from what is saved online:
// published_items and counters (views, likes, comments), live_sessions (peak, start and end) and live_totals()
// (Love taps and chat messages of each live, migration 007). Nothing is estimated: a figure that is not saved is
// left out. Post Love is no longer counted anywhere.
import { sb } from '../../shared/supabase.js';

// PostgREST returns at most 1000 rows a call, so read in pages.
async function all(make) {
  const out = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  return out;
}

export async function loadStats() {
  if (!navigator.onLine) throw new Error('The numbers need internet.');
  const [items, counters, sessions, totalsRes] = await Promise.all([
    all(() => sb.from('published_items').select('id,kind,title,status,published_at,duration')),
    all(() => sb.from('counters').select('item_id,n_views,n_like,n_comments')),
    all(() => sb.from('live_sessions').select('item_id,state,started_at,ended_at,peak_viewers')),
    sb.rpc('live_totals'),
  ]);
  const c = new Map(counters.map((x) => [x.item_id, x]));
  const t = new Map((totalsRes.error ? [] : totalsRes.data || []).map((x) => [x.item_id, x]));
  const byId = new Map(items.map((x) => [x.id, x]));

  const posts = items.filter((i) => i.status === 'published' && i.kind !== 'live').map((i) => ({
    id: i.id, title: i.title || 'Untitled', kind: i.kind, publishedAt: i.published_at,
    views: c.get(i.id)?.n_views || 0, likes: c.get(i.id)?.n_like || 0, comments: c.get(i.id)?.n_comments || 0,
  }));
  const lives = sessions.filter((s) => s.state === 'live' || s.state === 'ended').map((s) => {
    const a = s.started_at ? Date.parse(s.started_at) : 0;
    const b = s.ended_at ? Date.parse(s.ended_at) : 0;
    return {
      id: s.item_id, title: byId.get(s.item_id)?.title || 'Untitled', state: s.state, startedAt: s.started_at,
      minutes: a && b && b > a ? Math.round((b - a) / 60000) : null,
      peak: s.peak_viewers || 0, views: c.get(s.item_id)?.n_views || 0,
      love: t.has(s.item_id) ? Number(t.get(s.item_id).love) : null,
      chats: t.has(s.item_id) ? Number(t.get(s.item_id).chats) : null,
    };
  });
  return { posts, lives, haveLiveTotals: !totalsRes.error };
}

const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0);
const top = (list, f, n = 10) => [...list].sort((a, b) => (f(b) || 0) - (f(a) || 0)).filter((x) => (f(x) || 0) > 0).slice(0, n);

export function summarize({ posts, lives, haveLiveTotals }) {
  const mostWatched = top(lives, (l) => l.views, 1)[0] || null;
  const minutes = sum(lives, (l) => l.minutes);
  return {
    postCount: posts.length, liveCount: lives.length,
    postViews: sum(posts, (p) => p.views), liveViews: sum(lives, (l) => l.views),
    totalViews: sum(posts, (p) => p.views) + sum(lives, (l) => l.views),
    likes: sum(posts, (p) => p.likes), comments: sum(posts, (p) => p.comments),
    liveLove: haveLiveTotals ? sum(lives, (l) => l.love) : null,
    liveChats: haveLiveTotals ? sum(lives, (l) => l.chats) : null,
    liveMinutes: minutes, highestPeak: Math.max(0, ...lives.map((l) => l.peak)),
    mostWatched,
    rank: {
      liveViews: top(lives, (l) => l.views), livePeak: top(lives, (l) => l.peak), liveLove: top(lives, (l) => l.love),
      postViews: top(posts, (p) => p.views), postLikes: top(posts, (p) => p.likes), postComments: top(posts, (p) => p.comments),
    },
  };
}

export const fmtLiveTime = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);
