// Everything the public pages read or write. Viewers only ever reach published items.
import { CONFIG } from '../shared/config.js';
import { sbp } from '../shared/supabase-public.js';

export const mediaUrl = (key) => (key ? `${CONFIG.API_BASE}/public/${key}` : '');

async function must(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export const listItems = () => must(sbp.from('items_public').select('*').not('public_media_key', 'is', null).order('published_at', { ascending: false }).limit(120));

// The pictures for the home page hero (slot 1 to 7). Empty when none were uploaded or migration 008 is not run yet.
export const listHero = async () => { try { return await must(sbp.from('hero_images').select('slot,key,updated_at').order('slot')); } catch { return []; } };
// The parts of one live's album (recap parts), in order.
export const albumParts = (liveId) => must(sbp.from('items_public').select('id,title,album_title,album_pos,duration,public_thumb_key').eq('source_live_id', liveId).order('album_pos', { ascending: true }).limit(60));
export const getItem = (id) => must(sbp.from('items_public').select('*').eq('id', id).maybeSingle());
// The latest poems other than this one, for "More from Fabris".
export const listMore = (excludeId) =>
  must(sbp.from('items_public').select('id,title,public_thumb_key').neq('id', excludeId).not('public_media_key', 'is', null).order('published_at', { ascending: false }).limit(4));
// Four random regular posts for "More from Fabris" on a live that has ended. Posts made from a live recap and
// live replays are left out. Picked fresh on every visit. (Before migration 007 there is no source_live_id column
// and so no recap posts to leave out, which is why the second try drops that filter.)
export async function listRandomPosts(excludeId, n = 4) {
  const base = () => sbp.from('items_public').select('id,title,public_thumb_key,n_views,n_like,n_comments').neq('id', excludeId).neq('kind', 'live')
    .not('public_media_key', 'is', null).order('published_at', { ascending: false }).limit(200);
  let rows;
  try { rows = await must(base().is('source_live_id', null)); } catch { rows = await must(base()); }
  rows = [...(rows || [])];
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return rows.slice(0, n);
}
export const listComments = (id) =>
  must(sbp.from('comments').select('id,user_id,nickname,body,created_at').eq('item_id', id).order('created_at', { ascending: false }).limit(100));

// A person can give both Like and Love, so this returns a list of types.
export const myReactions = async (id, userId) =>
  (await must(sbp.from('reactions').select('type').eq('item_id', id).eq('user_id', userId))).map((r) => r.type);
export const setReaction = (id, userId, type) =>
  must(sbp.from('reactions').upsert({ item_id: id, user_id: userId, type }, { onConflict: 'item_id,user_id,type' }));
export const clearReaction = (id, userId, type) =>
  must(sbp.from('reactions').delete().eq('item_id', id).eq('user_id', userId).eq('type', type));
export const postComment = (id, userId, nickname, body) =>
  must(sbp.from('comments').insert({ item_id: id, user_id: userId, nickname, body }));
export const deleteComment = (commentId) => must(sbp.from('comments').delete().eq('id', commentId));

// One view per account per poem. The database ignores repeats; the local note only saves a call.
export async function recordView(id, userId) {
  const key = `fp.viewed.${userId}.${id}`;
  if (localStorage.getItem(key)) return;
  try {
    await must(sbp.rpc('record_view', { p_item: id }));
    localStorage.setItem(key, '1');
  } catch { /* counting is best effort */ }
}

// Turns a database error into something a person can read.
export function friendly(e) {
  const m = String(e?.message || e || '');
  if (/row-level security|violates/i.test(m)) return 'This is not available right now. You may have been blocked, or this item has closed reactions or comments.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection. Please try again.';
  return m || 'Something went wrong.';
}

// Live sessions (the safe view; chat, requests and the room itself come from the live room).
export const getLive = (id) => must(sbp.from('live_public').select('*').eq('id', id).maybeSingle());
// The next or current live, for the banner on the home page.
export const nextLive = () => must(sbp.from('live_public').select('id,title,state,starts_at').in('state', ['live', 'scheduled']).order('state', { ascending: true }).order('starts_at', { ascending: true, nullsFirst: false }).limit(1)).then((r) => r[0] || null);
