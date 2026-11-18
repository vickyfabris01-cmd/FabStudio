// The Deck: ONE player for the poem's own tune and for files from your laptop. Only one thing plays at a time.
// load() opens a file without starting it; play() opens and starts it; resume() starts what is loaded.
// Sound goes to the output you choose (the V8) with setSinkId; viewers hear it through the V8 loop into the
// soundcard input, exactly as before. LiveAudio is not touched. The Deck outlives the console screen, so a
// tune keeps playing while you move between tabs.
const OUT_KEY = 'fabstudio.live.out';

// Outputs the browser can see. Names stay generic until the microphone has been allowed once.
export async function listOutputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'Default output' : `Output ${i + 1}`) }));
  } catch { return []; }
}

export const canChooseOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

class Deck extends EventTarget {
  constructor() {
    super();
    this.audio = null;
    this.url = null;
    this.started = false;
    this.s = { source: null, key: null, name: '', playing: false, time: 0, duration: 0, volume: 1, outId: localStorage.getItem(OUT_KEY) || '', error: '' };
    this.tick = setInterval(() => { if (this.audio && this.s.playing) { this.s.time = this.audio.currentTime || 0; this.s.duration = this.audio.duration || this.s.duration; this.emit(); } }, 250);
  }

  emit() { this.dispatchEvent(new Event('change')); }
  on(fn) { this.addEventListener('change', fn); return () => this.removeEventListener('change', fn); }
  // fn({ source, key, name, fresh }) when something starts (fresh is false when it only resumes), onStop when it pauses or ends.
  onStart(fn) { const f = (e) => fn(e.detail); this.addEventListener('start', f); return () => this.removeEventListener('start', f); }
  onStop(fn) { this.addEventListener('stop', fn); return () => this.removeEventListener('stop', fn); }

  isPlaying(key) { return this.s.playing && (key == null || this.s.key === key); }
  isLoaded(key) { return this.s.key === key && !!this.audio; }

  // Opens a file (blob) in the player WITHOUT starting it, so picking something never puts it on air by itself.
  // source is 'poem' or 'file'; key tells which one it is.
  async load(blob, { source, key, name }) {
    this.unload(false);
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.preload = 'auto';
    a.volume = this.s.volume;
    a.onended = () => { this.s.playing = false; this.s.time = 0; this.emit(); this.dispatchEvent(new Event('stop')); };
    a.onerror = () => { this.unload(true); this.s.error = 'This audio could not be played.'; this.emit(); };
    a.onloadedmetadata = () => { this.s.duration = a.duration || 0; this.emit(); };
    this.audio = a; this.url = url; this.started = false;
    this.s = { ...this.s, source, key, name, playing: false, time: 0, duration: 0, error: '' };
    await this.applyOutput();
    this.emit();
    return true;
  }

  // Opens a file and starts it at once.
  async play(blob, meta) {
    await this.load(blob, meta);
    if (await this.resume()) return true;
    this.unload(true); this.s.error = 'The browser did not start the audio.'; this.emit();
    return false;
  }

  pause() { if (this.audio && this.s.playing) { this.audio.pause(); this.s.playing = false; this.emit(); this.dispatchEvent(new Event('stop')); } }
  // Starts or continues what is loaded. The first start of a loaded file counts as fresh (it gets its marker).
  async resume() {
    if (!this.audio || this.s.playing) return false;
    const fresh = !this.started;
    try { await this.audio.play(); } catch { this.s.error = 'The browser did not start the audio.'; this.emit(); return false; }
    this.started = true;
    this.s.playing = true;
    this.emit();
    this.dispatchEvent(new CustomEvent('start', { detail: { source: this.s.source, key: this.s.key, name: this.s.name, fresh } }));
    return true;
  }
  seek(t) { if (this.audio) { this.audio.currentTime = Math.max(0, t); this.s.time = this.audio.currentTime; this.emit(); } }
  setVolume(v) { this.s.volume = Math.min(1, Math.max(0, v)); if (this.audio) this.audio.volume = this.s.volume; this.emit(); }

  async setOutput(id) {
    this.s.outId = id || '';
    localStorage.setItem(OUT_KEY, this.s.outId);
    await this.applyOutput();
    this.emit();
  }

  async applyOutput() {
    if (!this.audio || !canChooseOutput()) return;
    try { await this.audio.setSinkId(this.s.outId || ''); this.s.error = ''; }
    catch { this.s.error = 'That output is not available. Choose another one.'; }
  }

  unload(silent) {
    const was = this.s.playing;
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); }
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio = null; this.url = null; this.started = false;
    this.s = { ...this.s, source: null, key: null, name: '', playing: false, time: 0, duration: 0 };
    if (was && !silent) this.dispatchEvent(new Event('stop'));
    if (silent) this.dispatchEvent(new Event('stop'));
  }

  stop() { this.unload(false); this.emit(); }
}

export const deck = new Deck();
