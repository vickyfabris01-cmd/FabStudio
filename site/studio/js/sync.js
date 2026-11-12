// Sync engine. Local data is the truth; the cloud is a replica.
//  1. Push: upload pending audio to R2, then upsert changed rows to Supabase.
//  2. Pull: fetch rows changed on the server since last time (last write wins).
import { sb } from '../../shared/supabase.js';
import { db, now, newer } from './db.js';
import { getToken } from './auth.js';
import { uploadBlob, deleteMedia, fetchMedia } from './api.js';

const T = {
  poems:    { remote: 'poems',         blob: false, fields: ['id','title','stanzas','tuneId','tuneVolume','createdAt','updatedAt','deletedAt'] },
  tunes:    { remote: 'tunes',         blob: true,  fields: ['id','title','mime','duration','r2Key','rightsNote','createdAt','updatedAt','deletedAt'] },
  captures: { remote: 'idea_captures', blob: true,  fields: ['id','poemId','mime','duration','r2Key','createdAt','updatedAt','deletedAt'] },
  bakes:    { remote: 'bakes',         blob: true,  fields: ['id','poemId','captureId','tuneId','tuneVolume','mime','duration','r2Key','createdAt','updatedAt','deletedAt'] },
};
const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const toRemote = (row, fields) => Object.fromEntries(fields.map((f) => [snake(f), row[f] ?? null]));
const fromRemote = (r, fields) => Object.fromEntries(fields.map((f) => [f, r[snake(f)] ?? null]));

let running = false;
let timer = null;
let state = { state: 'idle', pending: 0, error: null, last: null };

function emit(patch) {
  state = { ...state, ...patch };
  window.dispatchEvent(new CustomEvent('sync-state', { detail: state }));
}
export const getSyncState = () => state;

export async function pendingCount() {
  let n = 0;
  for (const t of Object.keys(T)) n += await db[t].where('dirty').equals(1).count();
  return n;
}

async function pushTable(name) {
  const cfg = T[name];
  const table = db[name];
  let firstError = null;
  const rows = await table.where('dirty').equals(1).toArray();
  for (const r of rows) {
    try {
      if (cfg.blob && r.deletedAt) {
        if (r.r2Key) await deleteMedia(r.r2Key);
        await table.where('id').equals(r.id).modify((x) => { x.r2Key = null; x.blobPending = 0; delete x.blob; });
      } else if (cfg.blob && r.blobPending && r.blob) {
        await uploadBlob(r.r2Key, r.blob);
        await table.update(r.id, { blobPending: 0 });
      }
      const fresh = await table.get(r.id);
      const { error } = await sb.from(cfg.remote).upsert(toRemote(fresh, cfg.fields), { onConflict: 'id' });
      if (error) throw error;
      // Clear the flag only if the row was not edited while we were uploading.
      await table.where('id').equals(r.id).and((x) => x.updatedAt === fresh.updatedAt).modify({ dirty: 0 });
    } catch (e) {
      firstError = firstError || e;
    }
  }
  if (firstError) throw firstError;
}

async function pullTable(name) {
  const cfg = T[name];
  const table = db[name];
  const metaKey = 'pull:' + name;
  let since = (await db.meta.get(metaKey))?.value || '1970-01-01T00:00:00Z';
  for (;;) {
    const { data, error } = await sb.from(cfg.remote).select('*').gt('server_updated_at', since)
      .order('server_updated_at', { ascending: true }).limit(500);
    if (error) throw error;
    if (!data.length) break;
    for (const rr of data) {
      const row = fromRemote(rr, cfg.fields);
      const local = await table.get(row.id);
      if (!local || (!local.dirty && newer(row.updatedAt, local.updatedAt))) {
        const merged = { ...(local || {}), ...row, dirty: 0 };
        if (!local && cfg.blob) merged.blobPending = 0;
        if (!local && name === 'captures') merged.status = 'done';
        if (merged.deletedAt) { delete merged.blob; merged.blobPending = 0; }
        await table.put(merged);
      }
    }
    since = data[data.length - 1].server_updated_at;
    await db.meta.put({ key: metaKey, value: since });
    if (data.length < 500) break;
  }
}

export async function syncNow() {
  if (running) return;
  running = true;
  try {
    if (!navigator.onLine) return emit({ state: 'offline', pending: await pendingCount() });
    if (!(await getToken())) return emit({ state: 'auth', pending: await pendingCount() });
    emit({ state: 'syncing', error: null });
    let pushError = null;
    for (const n of ['poems', 'tunes', 'captures', 'bakes']) {
      try { await pushTable(n); } catch (e) { pushError = pushError || e; }
    }
    for (const n of ['poems', 'tunes', 'captures', 'bakes']) await pullTable(n);
    if (pushError) throw pushError;
    emit({ state: 'idle', pending: await pendingCount(), last: now() });
  } catch (e) {
    emit({ state: 'error', error: String(e.message || e.status || e), pending: await pendingCount() });
  } finally {
    running = false;
  }
}

export function syncSoon(ms = 3000) {
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
  pendingCount().then((pending) => emit({ pending }));
}

let loopStarted = false;
export function startSyncLoop() {
  if (loopStarted) return;
  loopStarted = true;
  window.addEventListener('online', () => syncSoon(500));
  window.addEventListener('offline', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(500); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 60000);
  syncNow();
}

// Returns the audio file for a row, downloading it from R2 if this device does not have it yet.
export async function getBlob(table, row) {
  if (row.blob) return row.blob;
  if (!row.r2Key || row.deletedAt) return null;
  try {
    const blob = await fetchMedia(row.r2Key);
    await db[table].update(row.id, { blob });
    return blob;
  } catch {
    return null;
  }
}
