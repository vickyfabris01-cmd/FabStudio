// Everything the public pages read or write. Viewers only ever reach published items.
import { CONFIG } from '../shared/config.js';
import { sbp } from '../shared/supabase-public.js';

export const mediaUrl = (key) => (key ? `${CONFIG.API_BASE}/public/${key}` : '');

async function must(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export const listItems = () => must(sbp.from('items_public').select('*').order('published_at', { ascending: false }).limit(60));
export const getItem = (id) => must(sbp.from('items_public').select('*').eq('id', id).maybeSingle());
// The latest poems other than this one, for "More from Fabris".
export const listMore = (excludeId) =>
  must(sbp.from('items_public').select('id,title,public_thumb_key').neq('id', excludeId).order('published_at', { ascending: false }).limit(4));
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
