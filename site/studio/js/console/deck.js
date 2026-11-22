// The Deck: ONE player for the poem's own tune and for files from your laptop. Only one thing plays at a time.
// load() opens a file without starting it; play() opens and starts it; resume() starts what is loaded.
// Sound goes to the output you choose (the V8) with setSinkId; viewers hear it through the V8 loop into the
// soundcard input, exactly as before. LiveAudio is not touched. The Deck outlives the console screen, so a
// tune keeps playing while you move between tabs.
//
// Fades (music only; a poem's tune still starts and stops at once, as it always did):
//  - when something is playing and music is started (picked, Next, Previous, loop, or a poem tune started over music),
//    the new sound fades in while the old one fades out over TRANSITION_SECONDS, the two playing together;
//  - pausing music fades it out over STOP_SECONDS;
//  - looping starts the next track TRANSITION_SECONDS before the end, so it overlaps (see 'nearend').
const OUT_KEY = 'fabstudio.live.out';
export const TRANSITION_SECONDS = 4;   // old fades out and new fades in over this long
export const STOP_SECONDS = 1.5;       // pausing music fades out over this long

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
    this.out = new Set();     // sounds that are fading out after a crossfade: { a, url }
    this.nearFor = null;      // the element 'nearend' was already announced for
    this.s = { source: null, key: null, name: '', playing: false, time: 0, duration: 0, volume: 1, outId: localStorage.getItem(OUT_KEY) || '', error: '' };
    this.tick = setInterval(() => {
      if (this.audio && this.s.playing) {
        this.s.time = this.audio.currentTime || 0;
        this.s.duration = this.audio.duration || this.s.duration;
        this.emit();
        this.checkNearEnd();
      }
    }, 250);
  }

  emit() { this.dispatchEvent(new Event('change')); }
  on(fn) { this.addEventListener('change', fn); return () => this.removeEventListener('change', fn); }
  // fn({ source, key, name, fresh }) when something starts (fresh is false when it only resumes), onStop when it pauses or ends.
  onStart(fn) { const f = (e) => fn(e.detail); this.addEventListener('start', f); return () => this.removeEventListener('start', f); }
  onStop(fn) { this.addEventListener('stop', fn); return () => this.removeEventListener('stop', fn); }
  onEnded(fn) { const f = (e) => fn(e.detail); this.addEventListener('ended', f); return () => this.removeEventListener('ended', f); }
  // fn({ key }) once, when the playing music has TRANSITION_SECONDS left (only for tracks long enough to overlap).
  onNearEnd(fn) { const f = (e) => fn(e.detail); this.addEventListener('nearend', f); return () => this.removeEventListener('nearend', f); }

  isPlaying(key) { return this.s.playing && (key == null || this.s.key === key); }
  isLoaded(key) { return this.s.key === key && !!this.audio; }

  /* ----- volume and fades: each sound has its own level (0 to 1); the volume slider is the master on top ----- */
  applyVol(a) { a.volume = Math.min(1, Math.max(0, this.s.volume * (a._lvl ?? 1))); }

  // Moves a sound's level to `to` over `secs` seconds on an equal-power curve (so two sounds crossing keep an even loudness).
  fade(a, to, secs, done) {
    clearInterval(a._fade);
    a._fade = 0;
    const from = a._lvl ?? 1;
    if (!(secs > 0) || from === to) { a._lvl = to; this.applyVol(a); done?.(); return; }
    const t0 = performance.now();
    a._fade = setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / (secs * 1000));
      a._lvl = to > from ? from + (to - from) * Math.sin((p * Math.PI) / 2) : to + (from - to) * Math.cos((p * Math.PI) / 2);
      this.applyVol(a);
      if (p >= 1) { clearInterval(a._fade); a._fade = 0; done?.(); }
    }, 40);
  }

  // One sound element for a blob. Its events only count while it is the current one.
  makeAudio(url) {
    const a = new Audio(url);
    a.preload = 'auto';
    a._lvl = 1;
    this.applyVol(a);
    a.onended = () => {
      if (this.audio !== a) return;
      const key = this.s.key; this.s.playing = false; this.s.time = 0; this.emit(); this.dispatchEvent(new Event('stop')); this.dispatchEvent(new CustomEvent('ended', { detail: { key } }));   // 'ended' = it ran to its end (playlist.js uses it to loop)
    };
    a.onerror = () => { if (this.audio !== a) return; this.unload(true); this.s.error = 'This audio could not be played.'; this.emit(); };
    a.onloadedmetadata = () => { if (this.audio === a) { this.s.duration = a.duration || 0; this.emit(); } };
    return a;
  }

  // Opens a file (blob) in the player WITHOUT starting it, so picking something never puts it on air by itself.
  // source is 'poem' or 'file'; key tells which one it is.
  async load(blob, { source, key, name }) {
    this.unload(false);
    const url = URL.createObjectURL(blob);
    const a = this.makeAudio(url);
    this.audio = a; this.url = url; this.started = false; this.nearFor = null;
    this.s = { ...this.s, source, key, name, playing: false, time: 0, duration: 0, error: '' };
    await this.applyOutput();
    this.emit();
    return true;
  }

  // Opens a file and starts it at once. When something is playing and either side is music, the two crossfade.
  async play(blob, meta) {
    if (this.audio && this.s.playing && (this.s.source === 'file' || meta.source === 'file')) {
      const d = this.s.duration;
      const left = Number.isFinite(d) && d > 0 ? d - this.s.time : TRANSITION_SECONDS;   // a track about to end only fades for what is left
      return this.crossfadeTo(blob, meta, Math.max(0.5, Math.min(TRANSITION_SECONDS, left)));
    }
    await this.load(blob, meta);
    if (await this.resume()) return true;
    this.unload(true); this.s.error = 'The browser did not start the audio.'; this.emit();
    return false;
  }

  // Starts the new sound under the old one: it fades in while the old fades out, then the old is released.
  // If the browser will not start the new one, the old one just carries on.
  async crossfadeTo(blob, { source, key, name }, secs) {
    const url = URL.createObjectURL(blob);
    const a = this.makeAudio(url);
    a._lvl = 0; this.applyVol(a);
    await this.sink(a);
    try { await a.play(); } catch { a.onended = a.onerror = null; URL.revokeObjectURL(url); this.s.error = 'The browser did not start the audio.'; this.emit(); return false; }
    const prev = this.audio ? { a: this.audio, url: this.url } : null;
    this.audio = a; this.url = url; this.started = true; this.nearFor = null;
    this.s = { ...this.s, source, key, name, playing: true, time: 0, duration: 0, error: '' };
    if (prev) this.retire(prev, secs);
    this.fade(a, 1, secs);
    this.emit();
    this.dispatchEvent(new CustomEvent('start', { detail: { source, key, name, fresh: true } }));   // no 'stop' for the old one: this is one new start
    return true;
  }

  // The old sound fades out and is released. One that was already fading out when another crossfade starts is dropped quickly.
  retire(prev, secs) {
    for (const o of this.out) this.fade(o.a, 0, 0.25, () => this.release(o));
    prev.a.onended = prev.a.onerror = prev.a.onloadedmetadata = null;
    this.out.add(prev);
    this.fade(prev.a, 0, secs, () => this.release(prev));
  }
  release(o) {
    clearInterval(o.a._fade);
    try { o.a.pause(); } catch { /* ignore */ }
    if (o.url) URL.revokeObjectURL(o.url);
    this.out.delete(o);
  }
  releaseAll() { for (const o of [...this.out]) this.release(o); }

  // Music fades out (STOP_SECONDS) and then pauses; a poem's tune pauses at once. The state says "paused" straight away.
  pause() {
    const a = this.audio;
    if (!a || !this.s.playing) return;
    this.s.playing = false;
    this.s.time = a.currentTime || 0;
    this.emit();
    this.dispatchEvent(new Event('stop'));
    if (this.s.source === 'file') {
      a._stopping = true;
      this.fade(a, 0, STOP_SECONDS, () => {
        if (!a._stopping) return;
        a._stopping = false;
        a.pause(); a._lvl = 1; this.applyVol(a);
        if (this.audio === a) { this.s.time = a.currentTime || 0; this.emit(); }
      });
    } else a.pause();
  }
  // Starts or continues what is loaded. The first start of a loaded file counts as fresh (it gets its marker).
  // Pressing play while the music is still fading out simply brings it back.
  async resume() {
    if (!this.audio || this.s.playing) return false;
    const a = this.audio;
    if (a._stopping) { a._stopping = false; this.fade(a, 1, 0.4); }
    const fresh = !this.started;
    try { await a.play(); } catch { this.s.error = 'The browser did not start the audio.'; this.emit(); return false; }
    this.started = true;
    this.s.playing = true;
    this.emit();
    this.dispatchEvent(new CustomEvent('start', { detail: { source: this.s.source, key: this.s.key, name: this.s.name, fresh } }));
    return true;
  }
  seek(t) { if (this.audio) { this.audio.currentTime = Math.max(0, t); this.s.time = this.audio.currentTime; this.emit(); } }
  setVolume(v) {
    this.s.volume = Math.min(1, Math.max(0, v));
    if (this.audio) this.applyVol(this.audio);
    for (const o of this.out) this.applyVol(o.a);
    this.emit();
  }

  // Looping: announce once, TRANSITION_SECONDS before the end, so the next track can start over it.
  checkNearEnd() {
    const a = this.audio; const d = this.s.duration; const left = d - this.s.time;
    if (!a || this.s.source !== 'file' || this.nearFor === a || !Number.isFinite(d) || d < 2 * TRANSITION_SECONDS + 1) return;
    if (left <= TRANSITION_SECONDS && left > 0.3) { this.nearFor = a; this.dispatchEvent(new CustomEvent('nearend', { detail: { key: this.s.key } })); }
  }

  async setOutput(id) {
    this.s.outId = id || '';
    localStorage.setItem(OUT_KEY, this.s.outId);
    await this.applyOutput();
    this.emit();
  }

  async sink(a) {
    if (!a || !canChooseOutput()) return;
    try { await a.setSinkId(this.s.outId || ''); this.s.error = ''; }
    catch { this.s.error = 'That output is not available. Choose another one.'; }
  }
  async applyOutput() { await this.sink(this.audio); }

  unload(silent) {
    const was = this.s.playing;
    if (this.audio) { clearInterval(this.audio._fade); this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); }
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio = null; this.url = null; this.started = false; this.nearFor = null;
    this.s = { ...this.s, source: null, key: null, name: '', playing: false, time: 0, duration: 0 };
    if (was && !silent) this.dispatchEvent(new Event('stop'));
    if (silent) this.dispatchEvent(new Event('stop'));
  }

  stop() { this.releaseAll(); this.unload(false); this.emit(); }
}

export const deck = new Deck();
