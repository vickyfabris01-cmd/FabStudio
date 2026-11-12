// Mixes a voice recording with a background tune: live preview, and "bake" into one file.
// Bake plays the mix in real time into a recorder, so it takes as long as the poem.
import { pickMime } from './recorder.js';

const AC = window.AudioContext || window.webkitAudioContext;
const TAIL = 1.5; // seconds of tune left after the voice ends (fades out)

async function decode(ctx, blob) {
  return await ctx.decodeAudioData(await blob.arrayBuffer());
}

// Connects voice (+ looping tune with fade in/out) to `dest`. Returns timing.
function wire(ctx, dest, voiceBuf, tuneBuf, volume) {
  const t0 = ctx.currentTime + 0.15;
  const end = t0 + voiceBuf.duration + TAIL;
  const voice = ctx.createBufferSource();
  voice.buffer = voiceBuf;
  voice.connect(dest);
  voice.start(t0);
  if (tuneBuf) {
    const gain = ctx.createGain();
    const fadeOutAt = Math.max(t0 + 0.8, end - 2.2);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume, t0 + 0.8);
    gain.gain.setValueAtTime(volume, fadeOutAt);
    gain.gain.linearRampToValueAtTime(0, end);
    const tune = ctx.createBufferSource();
    tune.buffer = tuneBuf;
    tune.loop = true;
    tune.connect(gain);
    gain.connect(dest);
    tune.start(t0);
    tune.stop(end + 0.05);
  }
  return { t0, end };
}

export async function preview(voiceBlob, tuneBlob, volume, onEnd) {
  const ctx = new AC();
  await ctx.resume();
  const vb = await decode(ctx, voiceBlob);
  const tb = tuneBlob ? await decode(ctx, tuneBlob) : null;
  const { end } = wire(ctx, ctx.destination, vb, tb, volume);
  let finished = false;
  const finish = () => { if (finished) return; finished = true; clearTimeout(timer); ctx.close(); onEnd?.(); };
  const timer = setTimeout(finish, (end - ctx.currentTime) * 1000 + 200);
  return { stop: finish };
}

export async function bake(voiceBlob, tuneBlob, volume, onProgress) {
  const ctx = new AC();
  await ctx.resume();
  const vb = await decode(ctx, voiceBlob);
  const tb = tuneBlob ? await decode(ctx, tuneBlob) : null;
  const dest = ctx.createMediaStreamDestination();
  const mime = pickMime();
  const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  rec.start(1000);
  const { t0, end } = wire(ctx, dest, vb, tb, volume);
  const total = end - t0;
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      onProgress?.(Math.min(1, Math.max(0, (ctx.currentTime - t0) / total)));
      if (ctx.currentTime >= end + 0.1) { clearInterval(iv); resolve(); }
    }, 200);
  });
  rec.stop();
  await stopped;
  try { await wake?.release(); } catch { /* ignore */ }
  await ctx.close();
  return { blob: new Blob(parts, { type: rec.mimeType }), mime: rec.mimeType, duration: vb.duration + TAIL };
}
