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
export const listComments = (id) =>
  must(sbp.from('comments').select('id,user_id,nickname,body,created_at').eq('item_id', id).order('created_at', { ascending: false }).limit(100));
export const myReaction = async (id, userId) =>
  (await must(sbp.from('reactions').select('type').eq('item_id', id).eq('user_id', userId).maybeSingle()))?.type || null;
export const setReaction = (id, userId, type) =>
  must(sbp.from('reactions').upsert({ item_id: id, user_id: userId, type }, { onConflict: 'item_id,user_id' }));
export const clearReaction = (id, userId) => must(sbp.from('reactions').delete().eq('item_id', id).eq('user_id', userId));
export const postComment = (id, userId, nickname, body) =>
  must(sbp.from('comments').insert({ item_id: id, user_id: userId, nickname, body }));
export const deleteComment = (commentId) => must(sbp.from('comments').delete().eq('id', commentId));

// Play counts are approximate: one count per browser per item every 12 hours.
export async function recordPlay(id) {
  const key = 'fp.played.' + id;
  const last = Number(localStorage.getItem(key) || 0);
  if (Date.now() - last < 12 * 3600 * 1000) return;
  localStorage.setItem(key, String(Date.now()));
  try { await sbp.rpc('record_play', { p_item: id }); } catch { /* counting is best effort */ }
}

export const getNickname = () => localStorage.getItem('fp.nick') || '';
export async function saveNickname(nick) {
  localStorage.setItem('fp.nick', nick);
  try { await sbp.rpc('set_nickname', { p_nick: nick }); } catch { /* the comment still carries the nickname */ }
}

// Turns a database error into something a person can read.
export function friendly(e) {
  const m = String(e?.message || e || '');
  if (/row-level security|violates/i.test(m)) return 'This is not available right now. You may have been blocked, or this item has closed reactions or comments.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection. Please try again.';
  return m || 'Something went wrong.';
}
