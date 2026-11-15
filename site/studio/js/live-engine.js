// The live engine: one object that lives as long as the app is open, so the live keeps running while you
// move between tabs. It owns the room connection, the audio, the recording and the chat/queue state.
// Screens (live.js) only read engine.s and call its methods.
import { sb } from '../../shared/supabase.js';
import { connectRoom } from '../../shared/live-socket.js';
import { publishAudio } from '../../shared/sfu.js';
import { DEFAULT_SETTINGS, cleanSettings } from '../../shared/live-settings.js';
import { getToken } from './auth.js';
import { LiveAudio, startLiveRecording } from './live-audio.js';
import { syncSoon } from './sync.js';

const fresh = () => ({
  itemId: null, row: null,           // the live_sessions row (settings, starts_at, ...) and its item title
  conn: 'closed',                    // room connection: connecting | open | reconnecting | closed
  room: null,                        // last 'state' message from the room
  chat: [], watching: null, peak: 0, pulses: { love: 0, like: 0 },
  phase: 'idle',                     // idle | ready (soundcard open) | starting | live | ended
  audioState: '',                    // '' | connecting | ok | lost
  level: 0, error: '', captureId: null, recSeconds: 0,
});

class LiveEngine extends EventTarget {
  constructor() {
    super();
    this.s = fresh();
    this.audio = null; this.pub = null; this.rec = null; this.room = null;
    this.meter = null; this.repub = null; this.deviceId = '';
  }

  emit() { this.dispatchEvent(new Event('change')); }
  on(fn) { this.addEventListener('change', fn); return () => this.removeEventListener('change', fn); }
  get active() { return this.s.phase === 'live' || this.s.phase === 'starting'; }
  set(patch) { Object.assign(this.s, patch); this.emit(); }

  /* ---------- opening a session ---------- */
  async open(itemId) {
    if (this.s.itemId === itemId) return;
    if (this.active) throw new Error('A live is on air. End it first.');
    await this.close();
    const { data: item } = await sb.from('published_items').select('id,title,description').eq('id', itemId).single();
    const { data: row } = await sb.from('live_sessions').select('*').eq('item_id', itemId).single();
    if (!item || !row) throw new Error('This live was not found.');
    const settings = cleanSettings(row.settings, DEFAULT_SETTINGS);
    this.s = { ...fresh(), itemId, row: { ...row, settings, title: item.title, description: item.description }, phase: row.state === 'ended' ? 'ended' : 'idle', captureId: row.capture_id };
    this.room = connectRoom({
      item: itemId, getToken, console: true,
      onStatus: (c) => { this.set({ conn: c }); if (c === 'open') this.onOpen(); },
      onMessage: (m) => this.onMessage(m),
    });
    this.emit();
  }

  async close() {
    if (this.active) return;
    this.room?.close(); this.room = null;
    await this.stopAudio();
    this.s = fresh();
    this.emit();
  }

  // After every (re)connection: make sure the room has our title and settings, and re-announce the audio if we are live.
  onOpen() {
    const { row } = this.s;
    if (!row || this.s.phase === 'ended') return;
    this.room.send({ t: 'settings', settings: row.settings });
    this.room.send({ t: 'title', text: row.title });
    if (this.pub && this.s.phase === 'live') this.room.send({ t: 'broadcaster', sessionId: this.pub.sessionId, trackName: this.pub.trackName });
  }

  onMessage(m) {
    const s = this.s;
    switch (m.t) {
      case 'state':
        s.room = m;
        if (m.ownerSettings && s.row) s.row.settings = m.ownerSettings;
        if (typeof m.watching === 'number') s.watching = m.watching;
        if (typeof m.peak === 'number') s.peak = Math.max(s.peak, m.peak);
        if (m.status === 'ended' && s.phase !== 'ended') this.finish();
        break;
      case 'history': s.chat = m.chat || []; break;
      case 'chat': s.chat = [...s.chat, m.msg].slice(-300); break;
      case 'chatDel': s.chat = s.chat.filter((c) => c.id !== m.id); break;
      case 'count': s.watching = m.watching; if (typeof m.peak === 'number') s.peak = m.peak; break;
      case 'react': s.pulses = { love: s.pulses.love + (m.love || 0), like: s.pulses.like + (m.like || 0) }; break;
      case 'taken':
        // Another console took over the broadcast: stop sending here, keep the recording.
        this.dropAudioOnly();
        s.error = 'Another window took over the broadcast.';
        break;
      case 'err':
        if (m.code === 'already-live') s.error = 'This live is already on air from another window.';
        else if (m.code && !['rate'].includes(m.code)) s.error = `Room: ${m.code}`;
        break;
      default: break;
    }
    this.emit();
  }

  send(obj) { return this.room?.send(obj) ?? false; }

  /* ---------- host actions ---------- */
  async saveSettings(patch) {
    const row = this.s.row;
    row.settings = cleanSettings(patch, row.settings);
    this.send({ t: 'settings', settings: row.settings });
    await sb.from('live_sessions').update({ settings: row.settings }).eq('item_id', this.s.itemId);
    this.emit();
  }

  async saveTitle(title, description = this.s.row.description) {
    const t = String(title || '').trim().slice(0, 120);
    this.s.row.title = t; this.s.row.description = description;
    this.send({ t: 'title', text: t });
    await sb.from('published_items').update({ title: t, description, updated_at: new Date().toISOString() }).eq('id', this.s.itemId);
    this.emit();
  }

  /* ---------- the soundcard ---------- */
  async prepare(deviceId = this.deviceId) {
    this.deviceId = deviceId;
    if (this.audio) { await this.audio.useDevice(deviceId); return this.audio; }
    const a = new LiveAudio();
    await a.start({ deviceId });
    a.onLost = () => { if (this.s.phase === 'live') this.set({ error: 'The audio input was lost. Plug it back in, then press Retry audio.' , audioState: 'lost' }); };
    this.audio = a;
    this.meter = setInterval(() => { this.s.level = a.level(); if (this.rec) this.s.recSeconds = this.rec.seconds(); this.emit(); }, 100);
    if (this.s.phase === 'idle') this.s.phase = 'ready';
    this.emit();
    return a;
  }

  async stopAudio() {
    clearInterval(this.meter); this.meter = null;
    try { this.pub?.close(); } catch { /* closed */ }
    this.pub = null;
    if (this.audio) { await this.audio.stop(); this.audio = null; }
    if (this.s.phase === 'ready') this.s.phase = 'idle';
  }

  dropAudioOnly() { try { this.pub?.close(); } catch { /* closed */ } this.pub = null; this.s.audioState = 'lost'; }

  /* ---------- go live, retry, end ---------- */
  async goLive() {
    const s = this.s;
    if (s.phase === 'live' || s.phase === 'starting' || s.phase === 'ended') return;
    if (s.conn !== 'open') throw new Error('Not connected to the live room yet.');
    this.set({ phase: 'starting', error: '', audioState: 'connecting' });
    try {
      const a = await this.prepare();
      this.rec = await startLiveRecording(a.stream);
      s.captureId = this.rec.id;
      await this.publish(false);
      this.set({ phase: 'live', audioState: 'ok' });
      sb.from('live_sessions').update({ capture_id: this.rec.id }).eq('item_id', s.itemId).then(() => {});
      this.watchConnection();
    } catch (e) {
      try { await this.rec?.discard(); } catch { /* ignore */ }
      this.rec = null; s.captureId = null;
      try { this.pub?.close(); } catch { /* closed */ }
      this.pub = null;
      this.set({ phase: this.audio ? 'ready' : 'idle', audioState: '', error: friendly(e) });
      throw e;
    }
  }

  async publish(takeover) {
    const { settings } = this.s.row;
    this.pub = await publishAudio({ item: this.s.itemId, getToken, track: this.audio.track, kbps: settings.audioKbps, stereo: settings.stereo });
    const ok = await this.ack(takeover);
    if (!ok) { this.pub.close(); this.pub = null; throw new Error('This live is already on air from another window.'); }
  }

  // Tell the room which track is ours and wait for its answer (a state with our epoch, or an error).
  ack(takeover) {
    return new Promise((resolve) => {
      const stop = this.on(() => {
        const r = this.s.room;
        if (this.s.error.startsWith('This live is already')) { stop(); clearTimeout(t); resolve(false); }
        else if (r?.broadcaster?.online && r.broadcaster.sessionId === this.pub?.sessionId) { stop(); clearTimeout(t); resolve(true); }
      });
      const t = setTimeout(() => { stop(); resolve(false); }, 8000);
      this.s.error = '';
      this.send({ t: 'golive', sessionId: this.pub.sessionId, trackName: this.pub.trackName, takeover: !!takeover });
    });
  }

  // If the audio connection drops while live, rebuild it by itself (the recording keeps going).
  watchConnection() {
    const pc = this.pub?.pc;
    if (!pc) return;
    let timer = null;
    pc.onconnectionstatechange = () => {
      clearTimeout(timer);
      if (pc.connectionState === 'failed') this.retryAudio();
      else if (pc.connectionState === 'disconnected') timer = setTimeout(() => { if (pc.connectionState !== 'connected') this.retryAudio(); }, 4000);
      else if (pc.connectionState === 'connected') this.set({ audioState: 'ok' });
    };
  }

  async retryAudio() {
    if (this.s.phase !== 'live' || this.repub) return;
    this.repub = true;
    this.set({ audioState: 'connecting', error: '' });
    try {
      try { this.pub?.close(); } catch { /* closed */ }
      this.pub = null;
      if (!this.audio?.track || this.audio.track.readyState !== 'live') await this.audio.useDevice(this.deviceId);
      await this.publish(true);
      this.watchConnection();
      this.set({ audioState: 'ok' });
    } catch (e) {
      this.set({ audioState: 'lost', error: friendly(e) });
      setTimeout(() => { this.repub = null; if (this.s.phase === 'live' && this.s.audioState === 'lost') this.retryAudio(); }, 5000);
      return;
    }
    this.repub = null;
  }

  async end() {
    if (this.s.phase !== 'live') return;
    this.send({ t: 'end' });
    await this.finish();
  }

  // The live is over (we ended it, or the room says so): stop everything and keep the recording.
  async finish() {
    const s = this.s;
    if (s.phase === 'ended' && !this.rec) return;
    try { this.pub?.close(); } catch { /* closed */ }
    this.pub = null;
    let id = s.captureId;
    if (this.rec) { try { id = await this.rec.stop(); } catch (e) { s.error = friendly(e); } this.rec = null; }
    await this.stopAudio();
    s.phase = 'ended'; s.captureId = id; s.audioState = '';
    if (id) {
      await sb.from('live_sessions').update({ capture_id: id }).eq('item_id', s.itemId);
      syncSoon(500);
    }
    this.emit();
  }
}

const friendly = (e) => {
  const m = e?.message || String(e);
  if (e?.name === 'NotAllowedError') return 'The browser blocked the microphone. Allow it for this site and try again.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'That audio input was not found. Choose another one.';
  if (e?.status === 501) return 'Live audio is not set up on the Worker yet (see docs/LIVE.md, step 3).';
  if (e?.status === 401 || e?.status === 403) return 'Sign in again: the Worker did not accept this session.';
  return e?.detail ? `${m} (${e.detail})` : m;
};

export const engine = new LiveEngine();

// Warn before the tab is closed while on air.
window.addEventListener('beforeunload', (e) => { if (engine.active) { e.preventDefault(); e.returnValue = ''; } });
