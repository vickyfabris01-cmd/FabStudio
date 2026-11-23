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
    this.onMute = null;     // called with true/false when the input goes silent at the device (a stuck USB driver) or comes back
    this.onCtxState = null; // called when the browser's audio engine is suspended or running again
    this.activeId = '';     // the device id actually in use (it can change when a USB device is plugged back in)
    this.label = '';
    this.monitoring = false;
  }

  get track() { return this.stream?.getAudioTracks()[0] || null; }
  get inputTrack() { return this.mic?.getAudioTracks()[0] || null; }
  // The soundcard stopped delivering sound but the browser still lists the input as alive.
  get inputMuted() { const t = this.inputTrack; return !!t && (t.muted || t.readyState !== 'live'); }

  async start({ deviceId = '', gain = 1 } = {}) {
    let ctx;
    try { ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 }); }
    catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
    this.ctx = ctx;
    ctx.onstatechange = () => { this.onCtxState?.(ctx.state); };
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

  // Wakes the browser's audio engine if it was suspended (a USB glitch, a sleeping tab). Safe to call any time.
  async wake() {
    try { if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') await this.ctx.resume(); } catch { /* still asleep */ }
    return this.ctx?.state || 'closed';
  }

  // Raw on purpose: no echo cancelling, noise suppression or auto-gain. A soundcard mix must stay as you made it.
  // Switching input swaps only the source, so the stream (and the live and the recording) carries on.
  // Opening the same input again (or { reopen: true }) lets go of the old, possibly stuck, handle FIRST: some USB
  // drivers hand back silence while the old handle is still open. If the soundcard comes back under a new id,
  // the input with the same name is used.
  async useDevice(deviceId = '', { reopen = false } = {}) {
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } };
    const ask = (id) => navigator.mediaDevices.getUserMedia({ audio: id ? { ...base, deviceId: { exact: id } } : base });
    const release = () => {
      try { this.src?.disconnect(); } catch { /* already apart */ }
      this.mic?.getTracks().forEach((t) => { t.onended = null; t.onmute = null; t.onunmute = null; t.stop(); });
      this.src = null; this.mic = null;
    };
    const old = { src: this.src, mic: this.mic };
    const same = !deviceId || deviceId === this.activeId;
    const releaseFirst = reopen || same;
    if (releaseFirst) release();
    let mic;
    try { mic = await ask(deviceId); }
    catch (e) {
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') && this.label) {
        const alt = (await listInputs().catch(() => [])).find((d) => d.label === this.label && d.id !== deviceId);
        if (alt) mic = await ask(alt.id); else throw e;
      } else throw e;
    }
    this.mic = mic;
    this.src = this.ctx.createMediaStreamSource(mic);
    this.src.connect(this.gainNode);
    if (!releaseFirst) {
      if (old.src) old.src.disconnect();
      if (old.mic) old.mic.getTracks().forEach((t) => { t.onended = null; t.onmute = null; t.onunmute = null; t.stop(); });
    }
    const t = mic.getAudioTracks()[0];
    t.onended = () => this.onLost?.();
    t.onmute = () => this.onMute?.(true);
    t.onunmute = () => this.onMute?.(false);
    this.activeId = t.getSettings?.().deviceId || deviceId || '';
    this.label = t.label || this.label || 'Input';
    return this.label;
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
    this.onMute = null; this.onCtxState = null;
    this.mic?.getTracks().forEach((t) => { t.onended = null; t.onmute = null; t.onunmute = null; t.stop(); });
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
