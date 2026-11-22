// Loop all, previous and next for Music mode.
// The playlist is the file list of the folder the playing track was picked from, in the same order the picker
// shows it. Looking at another folder in the picker does not change it; picking a track there does.
// The Deck stays ONE player: this only decides which file to load next. When a track ends and loop is on, the next
// one is started with deck.play(), which is a fresh start, so it gets its own marker in the recording like any
// other file you start by hand. Poem tunes are not touched.
import { deck } from './deck.js';
import { fileKey } from './myaudio.js';
import { toast } from '../ui.js';

const LOOP_KEY = 'fabstudio.live.loop';

class Playlist extends EventTarget {
  constructor() {
    super();
    this.loop = localStorage.getItem(LOOP_KEY) === '1';
    this.ctx = null;        // { folderId, files: [{ path, name, handle }], index }
    this.trackFn = null;    // called with the track that is now current (so the header shows its name)
    deck.onEnded(({ key }) => { if (this.loop && this.ctx && key === this.currentKey()) this.step(1, true); });
    // Looping a long enough track: the next one starts over its last seconds (a crossfade). Short tracks loop at their end.
    deck.onNearEnd(({ key }) => { if (this.loop && this.ctx && key === this.currentKey()) this.step(1, true); });
  }
  emit() { this.dispatchEvent(new Event('change')); }
  on(fn) { this.addEventListener('change', fn); return () => this.removeEventListener('change', fn); }
  onTrack(fn) { this.trackFn = fn; }

  track(i = this.ctx?.index) { const f = this.ctx?.files[i]; return f ? { path: f.path, name: f.name, handle: f.handle, folderId: this.ctx.folderId, key: fileKey(this.ctx.folderId, f.path) } : null; }
  currentKey() { return this.track()?.key || null; }

  // A track was picked in a folder: that folder's list becomes the playlist.
  set(folderId, files, path) {
    const index = files.findIndex((f) => f.path === path);
    this.ctx = index < 0 ? null : { folderId, files, index };
    this.emit();
  }
  setLoop(on) { this.loop = !!on; localStorage.setItem(LOOP_KEY, this.loop ? '1' : '0'); this.emit(); }

  // dir = 1 for next, -1 for previous (both wrap inside the folder). play = start it; by default it starts only if
  // something was playing, so moving along the list while paused never puts audio on air by itself.
  async step(dir, play) {
    const ctx = this.ctx; if (!ctx || !ctx.files.length) return false;
    const wasPlaying = play ?? deck.isPlaying(this.currentKey());
    const n = ctx.files.length;
    for (let tries = 1; tries <= n; tries++) {
      const i = (((ctx.index + dir * tries) % n) + n) % n;
      const t = this.track(i);
      try {
        const file = await t.handle.getFile();
        const meta = { source: 'file', key: t.key, name: t.name };
        if (wasPlaying) { if (!(await deck.play(file, meta))) return false; } else await deck.load(file, meta);
        ctx.index = i;
        this.trackFn?.(t);
        this.emit();
        return true;
      } catch { /* that file is gone or not allowed any more: try the next one */ }
    }
    toast('None of the files in this folder could be opened. Allow the folder again, or check that it still exists.');
    return false;
  }
}

export const playlist = new Playlist();
