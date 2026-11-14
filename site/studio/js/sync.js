// Sync engine. Local data is the truth; the cloud is a replica.
//  1. Push: upload pending files to R2, then upsert changed rows to Supabase.
//  2. Pull: fetch rows changed on the server since last time (last write wins).
import { CONFIG } from '../../shared/config.js';
import { sb } from '../../shared/supabase.js';
import { db, now, newer } from './db.js';
import { getToken } from './auth.js';
import { uploadBlob, deleteMedia, fetchMedia } from './api.js';

const T = {
  poems:    { remote: 'poems',           fields: ['id','title','stanzas','tuneId','tuneVolume','createdAt','updatedAt','deletedAt'] },
  tunes:    { remote: 'tunes',           fields: ['id','title','mime','duration','r2Key','rightsNote','createdAt','updatedAt','deletedAt'] },
  captures: { remote: 'idea_captures',   fields: ['id','poemId','mime','duration','r2Key','createdAt','updatedAt','deletedAt'] },
  bakes:    { remote: 'bakes',           fields: ['id','poemId','captureId','tuneId','tuneVolume','mime','duration','r2Key','createdAt','updatedAt','deletedAt'] },
  items:    { remote: 'published_items', fields: ['id','kind','poemId','title','description','poemTitle','poemStanzas','mime','duration','mediaKey','thumbKey','publicMediaKey','publicThumbKey','status','publishedAt','commentsEnabled','reactionsEnabled','createdAt','updatedAt'] },
};
// Files that belong to each row: which field holds the file, its R2 key, and its "still to upload" flag.
const FILE = { blob: 'blob', key: 'r2Key', pending: 'blobPending' };
const BLOBS = {
  poems: [],
  tunes: [FILE],
  captures: [FILE],
  bakes: [FILE],
  items: [
    { blob: 'blob', key: 'mediaKey', pending: 'mediaPending' },
    { blob: 'thumbBlob', key: 'thumbKey', pending: 'thumbPending' },
  ],
};
const ORDER = ['poems', 'tunes', 'captures', 'bakes', 'items'];
const snake = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const toRemote = (row, fields) => Object.fromEntries(fields.map((f) => [snake(f), row[f] ?? null]));
const fromRemote = (r, fields) => Object.fromEntries(fields.map((f) => [f, r[snake(f)] ?? null]));

let running = false;
let timer = null;
let state = { state: 'idle', pending: 0, error: null, last: null };

// Adds "where it failed" and a plain hint to an error, so Settings shows something useful.
function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || '(not set)'); }
}
function tag(e, where) {
  if (e && e.tagged) return e;
  const raw = String(e?.message || e?.error_description || e || 'unknown error');
  const bits = [where, raw];
  if (e?.status) bits.push('HTTP ' + e.status);
  if (e?.code) bits.push('code ' + e.code);
  if (e?.details) bits.push(String(e.details));
  if (e?.hint) bits.push('hint: ' + e.hint);
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    bits.push(`no answer from the server (CORS block, wrong address or no network). Page ${location.origin}, Worker ${hostOf(CONFIG.API_BASE)}, Supabase ${hostOf(CONFIG.SUPABASE_URL)}`);
  }
  console.error('[sync]', where, e);
  const err = new Error(bits.join(' | '));
  err.status = e?.status;
  err.tagged = true;
  return err;
}

function emit(patch) {
  state = { ...state, ...patch };
  window.dispatchEvent(new CustomEvent('sync-state', { detail: state }));
}
export const getSyncState = () => state;

export async function pendingCount() {
  let n = 0;
  for (const t of ORDER) n += await db[t].where('dirty').equals(1).count();
  return n;
}

async function pushTable(name) {
  const cfg = T[name];
  const table = db[name];
  const files = BLOBS[name];
  const errors = [];
  const rows = await table.where('dirty').equals(1).toArray();
  for (const r of rows) {
    let step = 'start';
    try {
      if (r.deletedAt && files.length) {
        for (const f of files) {
          if (r[f.key]) { step = 'delete file ' + r[f.key]; await deleteMedia(r[f.key]); }
        }
        await table.where('id').equals(r.id).modify((x) => {
          for (const f of files) { x[f.key] = null; x[f.pending] = 0; delete x[f.blob]; }
        });
      } else {
        for (const f of files) {
          if (r[f.pending] && r[f.blob]) {
            step = 'upload ' + r[f.key];
            await uploadBlob(r[f.key], r[f.blob]);
            await table.update(r.id, { [f.pending]: 0 });
          }
        }
      }
      step = 'save row to Supabase';
      const fresh = await table.get(r.id);
      const { error } = await sb.from(cfg.remote).upsert(toRemote(fresh, cfg.fields), { onConflict: 'id' });
      if (error) throw error;
      // Clear the flag only if the row was not edited while we were uploading.
      await table.where('id').equals(r.id).and((x) => x.updatedAt === fresh.updatedAt)
        .modify(name === 'items' ? { dirty: 0, remote: 1 } : { dirty: 0 });
    } catch (e) {
      errors.push(tag(e, `push ${name} ${String(r.id).slice(0, 8)} (${step})`));
    }
  }
  if (errors.length) {
    const first = errors[0];
    if (errors.length > 1) first.message += ` (+${errors.length - 1} more in ${name})`;
    throw first;
  }
}

async function pullTable(name) {
  const cfg = T[name];
  const table = db[name];
  const files = BLOBS[name];
  const metaKey = 'pull:' + name;
  let step = 'read changes';
  try {
    let since = (await db.meta.get(metaKey))?.value || '1970-01-01T00:00:00Z';
    for (;;) {
      step = 'read changes';
      const { data, error } = await sb.from(cfg.remote).select('*').gt('server_updated_at', since)
        .order('server_updated_at', { ascending: true }).limit(500);
      if (error) throw error;
      if (!data.length) break;
      step = 'save locally';
      for (const rr of data) {
        const row = fromRemote(rr, cfg.fields);
        const local = await table.get(row.id);
        if (!local || (!local.dirty && newer(row.updatedAt, local.updatedAt))) {
          const merged = { ...(local || {}), ...row, dirty: 0 };
          if (name === 'items') merged.remote = 1;
          if (!local) for (const f of files) merged[f.pending] = 0;
          if (!local && name === 'captures') merged.status = 'done';
          if (merged.deletedAt) for (const f of files) { delete merged[f.blob]; merged[f.pending] = 0; }
          await table.put(merged);
        }
      }
      since = data[data.length - 1].server_updated_at;
      await db.meta.put({ key: metaKey, value: since });
      if (data.length < 500) break;
    }
    if (name === 'items') {
      // Items deleted elsewhere are removed here too (items are hard-deleted, not tombstoned).
      step = 'check deleted items';
      const { data: ids, error } = await sb.from(cfg.remote).select('id');
      if (error) throw error;
      const have = new Set(ids.map((r) => r.id));
      await db.items.filter((x) => x.remote === 1 && !x.dirty && !have.has(x.id)).delete();
    }
  } catch (e) {
    throw tag(e, `pull ${name} (${step})`);
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
    let pullError = null;
    for (const n of ORDER) {
      try { await pushTable(n); } catch (e) { pushError = pushError || e; }
    }
    for (const n of ORDER) {
      try { await pullTable(n); } catch (e) { pullError = pullError || e; }
    }
    const failure = pushError || pullError;
    if (failure) throw failure;
    emit({ state: 'idle', pending: await pendingCount(), last: now() });
  } catch (e) {
    emit({ state: 'error', error: String(e.message || e.status || e), pending: await pendingCount() });
  } finally {
    running = false;
  }
}

// Waits for a sync already in progress, then runs a fresh one. Used before publishing.
export async function syncAndWait() {
  while (running) await new Promise((r) => setTimeout(r, 300));
  await syncNow();
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