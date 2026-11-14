// Mixing voice and a background tune.
//  LiveMix: records the microphone and the tune together, as it happens (the baking page).
//  Remix / rebake: play or re-record the saved voice and tune at a new tune volume (the preview modal).
import { pickMime } from './recorder.js';

const AC = window.AudioContext || window.webkitAudioContext;
export const BAKE_TUNE_VOLUME = 0.5; // tune level while baking; the voice is always 1.0

/* ---------- live ---------- */
export class LiveMix {
  constructor(tuneBlob, volume = BAKE_TUNE_VOLUME) {
    this.ctx = new AC();
    this.tuneBlob = tuneBlob;
    this.volume = volume;
    this.tuneBuf = null;
    this.rec = null;
    this.tuneSrc = null;
    this.tuneOffset = null; // seconds after the mix started that the tune began
    this.onTuneEnd = null;
  }

  async load() {
    if (this.tuneBlob) this.tuneBuf = await this.ctx.decodeAudioData(await this.tuneBlob.arrayBuffer());
  }

  get recording() { return !!this.rec && this.rec.state === 'recording'; }
  get tunePlaying() { return !!this.tuneSrc; }

  async begin(stream) {
    await this.ctx.resume();
    this.dest = this.ctx.createMediaStreamDestination();
    const mic = this.ctx.createMediaStreamSource(stream);
    const voice = this.ctx.createGain();
    voice.gain.value = 1;
    mic.connect(voice);
    voice.connect(this.dest);
    const mime = pickMime();
    this.rec = new MediaRecorder(this.dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
    this.parts = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.parts.push(e.data); };
    this.stopped = new Promise((res) => { this.rec.onstop = res; });
    this.rec.start(1000);
    this.t0 = this.ctx.currentTime;
    this.wall0 = Date.now();
  }

  // Plays the tune once. It goes into the recording and to the headphones. Recording carries on when it ends.
  startTune() {
    if (!this.tuneBuf || this.tuneSrc || this.tuneOffset != null || !this.recording) return false;
    const gain = this.ctx.createGain();
    gain.gain.value = this.volume;
    const src = this.ctx.createBufferSource();
    src.buffer = this.tuneBuf;
    src.connect(gain);
    gain.connect(this.dest);
    gain.connect(this.ctx.destination);
    this.tuneOffset = this.ctx.currentTime - this.t0;
    src.onended = () => { this.tuneSrc = null; this.onTuneEnd?.(); };
    src.start();
    this.tuneSrc = src;
    return true;
  }

  async finish() {
    try { this.tuneSrc?.stop(); } catch { /* already ended */ }
    this.rec.stop();
    await this.stopped;
    const duration = (Date.now() - this.wall0) / 1000;
    await this.ctx.close().catch(() => {});
    return { blob: new Blob(this.parts, { type: this.rec.mimeType }), mime: this.rec.mimeType, duration, tuneOffset: this.tuneOffset };
  }

  dispose() { this.ctx.close().catch(() => {}); }
}

/* ---------- remix ---------- */
// Decodes the saved voice (and tune) into one audio context.
export async function loadRemix(voiceBlob, tuneBlob) {
  const ctx = new AC();
  const voice = await ctx.decodeAudioData(await voiceBlob.arrayBuffer());
  const tune = tuneBlob ? await ctx.decodeAudioData(await tuneBlob.arrayBuffer()) : null;
  return { ctx, voice, tune };
}

// Plays voice at full level and the tune (once, from `offset` seconds in) at `volume`, to `out`.
export class Remix {
  constructor(m, offset, volume, out) {
    this.m = m;
    this.ctx = m.ctx;
    this.offset = offset || 0;
    this.out = out || m.ctx.destination;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(this.out);
    this.duration = m.voice.duration;
    this.srcs = [];
    this.playing = false;
    this.startAt = 0;
    this.last = 0;
    this.onEnd = null;
  }

  pos() { return this.playing ? Math.min(this.duration, Math.max(0, this.ctx.currentTime - this.startAt)) : this.last; }

  start(from = 0) {
    this.halt();
    const c = this.ctx;
    const t = c.currentTime + 0.1;
    const v = c.createBufferSource();
    v.buffer = this.m.voice;
    v.connect(this.out);
    v.start(t, from);
    this.srcs = [v];
    if (this.m.tune) {
      const rel = this.offset - from;
      const u = c.createBufferSource();
      u.buffer = this.m.tune;
      u.connect(this.gain);
      let began = false;
      if (rel >= 0) { u.start(t + rel); began = true; }
      else if (-rel < this.m.tune.duration) { u.start(t, -rel); began = true; }
      if (began) { u.stop(t + (this.duration - from) + 0.05); this.srcs.push(u); }
    }
    this.startAt = t - from;
    this.playing = true;
    v.onended = () => {
      if (!this.srcs.includes(v)) return;
      this.playing = false;
      this.last = 0;
      this.onEnd?.();
    };
  }

  halt() {
    if (this.playing) this.last = this.pos();
    this.playing = false;
    const old = this.srcs;
    this.srcs = [];
    for (const s of old) { try { s.stop(); } catch { /* not started */ } }
  }

  setVolume(v) { this.gain.gain.value = v; }
}

// Re-records the mix at a new tune volume. Runs in real time, so it takes as long as the poem.
export async function rebake(m, offset, volume, onProgress) {
  await m.ctx.resume();
  const dest = m.ctx.createMediaStreamDestination();
  const mime = pickMime();
  const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  const r = new Remix(m, offset, volume, dest);
  rec.start(1000);
  r.start(0);
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      onProgress?.(Math.min(1, r.pos() / r.duration));
      if (!r.playing) { clearInterval(iv); resolve(); }
    }, 200);
  });
  rec.stop();
  await stopped;
  try { await wake?.release(); } catch { /* ignore */ }
  return { blob: new Blob(parts, { type: rec.mimeType }), mime: rec.mimeType, duration: r.duration };
}
