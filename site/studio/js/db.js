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

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const newer = (a, b) => Date.parse(a) > Date.parse(b);
