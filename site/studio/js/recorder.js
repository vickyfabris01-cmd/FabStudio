// Idea capture. Audio chunks are written to IndexedDB every 3 seconds, so a crash,
// dead battery or lost tab never loses a recording.
import { db, uid, now } from './db.js';
import { extFor, probeDuration } from './ui.js';

let active = null;
export const isRecording = () => !!active;

export function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return window.MediaRecorder ? options.find((m) => MediaRecorder.isTypeSupported(m)) || '' : '';
}

// opts: { poemId, deviceId, raw }  raw = true turns off voice processing (use with a soundcard / music).
export async function startCapture(opts = {}) {
  if (active) throw new Error('Already recording');
  const audio = {
    echoCancellation: !opts.raw,
    noiseSuppression: !opts.raw,
    autoGainControl: !opts.raw,
  };
  if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: opts.raw ? 128000 : 64000 } : undefined);
  const id = uid();
  const t = now();
  await db.captures.put({
    id, poemId: opts.poemId || null, mime: rec.mimeType, status: 'recording', duration: 0,
    createdAt: t, updatedAt: t, dirty: 0, blobPending: 0, r2Key: `captures/${id}.${extFor(rec.mimeType)}`,
  });
  const writes = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) writes.push(db.chunks.add({ captureId: id, blob: e.data })); };
  const stopped = new Promise((res) => { rec.onstop = res; });
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  const t0 = Date.now();
  rec.start(3000);
  active = {
    id,
    async stop() {
      rec.stop();
      await stopped;
      await Promise.all(writes);
      stream.getTracks().forEach((tr) => tr.stop());
      try { await wake?.release(); } catch { /* ignore */ }
      active = null;
      await finalize(id, (Date.now() - t0) / 1000);
      return id;
    },
  };
  return active;
}

// Joins the saved chunks into one file and marks the capture ready to sync.
export async function finalize(id, seconds) {
  const cap = await db.captures.get(id);
  if (!cap) return;
  const chunks = await db.chunks.where('captureId').equals(id).sortBy('seq');
  if (!chunks.length) { await db.captures.delete(id); return; }
  const blob = new Blob(chunks.map((c) => c.blob), { type: cap.mime });
  const duration = seconds ?? (await probeDuration(blob));
  await db.transaction('rw', db.captures, db.chunks, async () => {
    await db.captures.update(id, { blob, status: 'done', duration, updatedAt: now(), dirty: 1, blobPending: 1 });
    await db.chunks.where('captureId').equals(id).delete();
  });
}

// On app start: rescue any recording that was interrupted.
export async function recoverOrphans() {
  const orphans = await db.captures.where('status').equals('recording').toArray();
  for (const c of orphans) await finalize(c.id, null);
}
