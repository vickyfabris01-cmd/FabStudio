// Local database (IndexedDB via Dexie). This is the source of truth on the device.
// `dirty` = 1 means the row still has to be pushed to Supabase.
// `blobPending` = 1 means the audio file still has to be uploaded to R2.
export const db = new Dexie('fabstudio');

db.version(1).stores({
  poems: 'id, updatedAt, dirty',
  captures: 'id, poemId, status, createdAt, dirty',
  chunks: '++seq, captureId',
  tunes: 'id, createdAt, dirty',
  bakes: 'id, poemId, createdAt, dirty',
  uploads: 'key',
  meta: 'key',
});

// Phase 2: items to publish (audio or video, with a thumbnail).
db.version(2).stores({
  items: 'id, status, updatedAt, dirty',
});

// Undo support. The first time a published item gets a change that waits for Update (needsRepublish goes 0 -> 1),
// the fields that describe what is public now are copied into `baseline`, and every file slot that changes after
// that is listed in baseline.slots. Nothing else in the app has to know about it. It is local only (never synced),
// and it is cleared when the item is published again, unpublished, or the changes are undone.
const BASE_FIELDS = ['kind', 'mime', 'duration', 'mediaKey', 'publicMediaKey', 'thumbKey', 'publicThumbKey', 'thumbKind', 'thumbVariant',
  'altKey', 'publicAltKey', 'altMime', 'altDuration', 'bgKey', 'publicBgKey', 'scene', 'lyrics', 'lyricsDraft', 'showLyrics', 'youtubeId'];
const SLOT_BLOBS = ['blob', 'thumbBlob', 'altBlob', 'bgBlob'];
export { BASE_FIELDS };
db.items.hook('updating', (mods, _key, obj) => {
  if (mods.needsRepublish === 0 || (mods.status && mods.status !== 'published')) return obj.baseline ? { baseline: null } : undefined;
  const starting = mods.needsRepublish === 1 && !obj.needsRepublish && obj.status === 'published';
  if (!starting && !obj.baseline) return undefined;
  const base = obj.baseline || { slots: [] };
  if (starting && !obj.baseline) for (const f of BASE_FIELDS) if (obj[f] !== undefined) base[f] = obj[f];
  const slots = new Set(base.slots);
  for (const b of SLOT_BLOBS) if (b in mods) slots.add(b);
  return { baseline: { ...base, slots: [...slots] } };
});

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const newer = (a, b) => Date.parse(a) > Date.parse(b);