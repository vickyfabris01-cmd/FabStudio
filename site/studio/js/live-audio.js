// Live audio on the laptop: pick the soundcard, mix it into ONE stream, and record that same stream locally.
// That one stream feeds both the SFU (viewers) and the recorder, so what viewers hear is what you keep.
import { db, uid, now } from './db.js';
import { extFor } from './ui.js';
import { pickMime, finalize } from './recorder.js';

// Inputs the browser can see. Names stay hidden until the person has allowed the microphone once.
export async function listInputs() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* permission denied: names stay generic */ }
  }
  return devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
}

export class LiveAudio {
  constructor() {
    this.ctx = null;
    this.mic = null;        // the raw stream from the soundcard
    this.src = null;
    this.stream = null;     // the mixed stream: this is what is sent and recorded
    this.onLost = null;     // called when the chosen input disappears (unplugged, driver reset)
    this.monitoring = false;
  }

  get track() { return this.stream?.getAudioTracks()[0] || null; }

  async start({ deviceId = '', gain = 1 } = {}) {
    let ctx;
    try { ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 }); }
    catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
    this.ctx = ctx;
    this.dest = ctx.createMediaStreamDestination();
    this.dest.channelCount = 2;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = gain;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096; // about 85 ms of sound, so the meter reads every 100 ms without gaps
    this.buf = new Float32Array(this.analyser.fftSize);
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.gainNode.connect(this.analyser);
    this.gainNode.connect(this.dest);
    this.gainNode.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination); // silent until Monitor is switched on
    this.stream = this.dest.stream;
    const label = await this.useDevice(deviceId);
    await ctx.resume();
    return label;
  }

  // Raw on purpose: no echo cancelling, noise suppression or auto-gain. A soundcard mix must stay as you made it.
  // Switching input swaps only the source, so the stream (and the live and the recording) carries on.
  async useDevice(deviceId = '') {
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    const mic = await navigator.mediaDevices.getUserMedia({ audio });
    const old = { src: this.src, mic: this.mic };
    this.mic = mic;
    this.src = this.ctx.createMediaStreamSource(mic);
    this.src.connect(this.gainNode);
    if (old.src) old.src.disconnect();
    if (old.mic) old.mic.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    const t = mic.getAudioTracks()[0];
    t.onended = () => this.onLost?.();
    return t.label || 'Input';
  }

  setGain(v) { if (this.gainNode) this.gainNode.gain.value = v; }

  // Hear what is being sent. Off by default: with speakers it will echo into the microphone.
  setMonitor(on) {
    this.monitoring = !!on;
    if (this.monitorGain) this.monitorGain.gain.value = on ? 1 : 0;
  }

  // 0 to 1, from the level in decibels (silence at -60 dB, loud at 0 dB).
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length) || 1e-6;
    return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 60));
  }

  async stop() {
    this.onLost = null;
    this.mic?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    try { this.src?.disconnect(); } catch { /* ignore */ }
    try { await this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = this.mic = this.src = this.stream = null;
  }
}

// Records the mixed stream to this laptop, in 3 second pieces saved as they arrive, so a crash or a closed tab
// loses at most a moment. It does NOT use the Poems recorder, so tabs and the Poems screen keep working during a live.
// When stopped, the recording is joined into one file and syncs to your private R2 bucket like any capture.
export async function startLiveRecording(stream) {
  if (!window.MediaRecorder) throw new Error('This browser cannot record.');
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  const id = uid();
  const t = now();
  await db.captures.put({
    id, poemId: null, mime: rec.mimeType, status: 'recording', duration: 0,
    createdAt: t, updatedAt: t, dirty: 0, blobPending: 0, r2Key: `captures/${id}.${extFor(rec.mimeType)}`,
  });
  const writes = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) writes.push(db.chunks.add({ captureId: id, blob: e.data })); };
  const stopped = new Promise((res) => { rec.onstop = res; });
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  const t0 = Date.now();
  rec.start(3000);
  let done = false;
  return {
    id,
    seconds: () => (Date.now() - t0) / 1000,
    async stop() {
      if (done) return id;
      done = true;
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      await Promise.all(writes);
      try { await wake?.release(); } catch { /* ignore */ }
      await finalize(id, (Date.now() - t0) / 1000);
      return id;
    },
    // Throws the recording away (the live never started).
    async discard() {
      done = true;
      try { if (rec.state !== 'inactive') rec.stop(); await stopped; } catch { /* ignore */ }
      await Promise.all(writes);
      try { await wake?.release(); } catch { /* ignore */ }
      await db.chunks.where('captureId').equals(id).delete();
      await db.captures.delete(id);
    },
  };
}
