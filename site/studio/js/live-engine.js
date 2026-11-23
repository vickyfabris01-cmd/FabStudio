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
import { db } from './db.js';

const fresh = () => ({
  itemId: null, row: null,           // the live_sessions row (settings, starts_at, ...) and its item title
  conn: 'closed',                    // room connection: connecting | open | reconnecting | closed
  room: null,                        // last 'state' message from the room
  chat: [], watching: null, peak: 0, pulses: { love: 0, like: 0 },
  baseSeq: null, views: 0, love: 0, shares: 0,      // this live's views (new ones only), Love taps and shares
  events: [], seq: 0,                // lines only the host sees (joined, love bursts); seq numbers every feed line
  lovePulse: { n: 0, k: 0 },         // k goes up on every real Love message, so the chat pane can float hearts (n = taps in it)
  show: { title: false, poem: '', playing: '' },   // what viewers may see (the room enforces show-title)
  markers: [],                       // { t seconds into the recording, label, kind }
  phase: 'idle',                     // idle | ready (soundcard open) | starting | live | ended
  audioState: '',                    // '' | connecting | ok | lost
  level: 0, error: '', captureId: null, recSeconds: 0,
  inputMuted: false,                 // the soundcard stopped delivering sound (the browser still lists it)
  sending: null,                     // true/false: are audio packets leaving this laptop (null: not known yet)
  silentFor: 0,                      // seconds the input level has been silent
  listeners: null,                   // the room's summary of what listeners get: { n, good, fair, poor, stalled, silent, rcv }
});

const withTimeout = (p, ms, message) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(message)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

class LiveEngine extends EventTarget {
  constructor() {
    super();
    this.s = fresh();
    this.audio = null; this.pub = null; this.rec = null; this.room = null;
    this.meter = null; this.repub = 0; this.deviceId = '';
    this.pubSeq = 0;                                // each publish gets a number; a late, older one is thrown away
    this.healthTimer = null; this.lastPackets = null; this.noSendTicks = 0; this.mutedTicks = 0; this.offTicks = 0; this.lastAuto = 0; this.lastAnnounce = 0;
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
    this.s = { ...fresh(), itemId, row: { ...row, settings, title: item.title, description: item.description }, phase: row.state === 'ended' ? 'ended' : 'idle', captureId: row.capture_id, markers: Array.isArray(row.markers) ? row.markers : [] };
    this.seenReq = new Set();
    this.helloed = false;
    this.loadCounts(itemId);
    // Safety net: the counts are also read from the database every 15 seconds, in case a message was missed.
    clearInterval(this.countsTimer);
    this.countsTimer = setInterval(() => { if (navigator.onLine && this.s.itemId === itemId) this.loadCounts(itemId); }, 15000);
    this.room = connectRoom({
      item: itemId, getToken, console: true,
      onStatus: (c) => { if (c !== 'open') this.helloed = false; this.set({ conn: c }); },   // onOpen() now runs when the room's first 'state' arrives, i.e. after it has accepted our hello
      onMessage: (m) => this.onMessage(m),
    });
    this.emit();
  }

  async close() {
    if (this.active) return;
    clearInterval(this.countsTimer);
    this.stopHealth();
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
    this.sendPoems();
    this.sendShow();
    // We are the broadcaster, so take the room back: after a drop the room may still hold our old, dead connection
    // and would otherwise answer "already on air from another window".
    if (this.pub && this.s.phase === 'live') this.room.send({ t: 'broadcaster', sessionId: this.pub.sessionId, trackName: this.pub.trackName, takeover: true });
  }

  onMessage(m) {
    const s = this.s;
    switch (m.t) {
      case 'state':
        if (!this.helloed && this.room) { this.helloed = true; this.onOpen(); }
        s.room = m;
        if (m.ownerSettings && s.row) s.row.settings = m.ownerSettings;
        if (typeof m.watching === 'number') s.watching = m.watching;
        if (typeof m.peak === 'number') s.peak = Math.max(s.peak, m.peak);
        if (typeof m.loveTotal === 'number') s.love = Math.max(s.love, m.loveTotal);
        if (typeof m.shares === 'number') s.shares = Math.max(s.shares, m.shares);
        this.noteRequests(m.requests);
        if (m.status === 'ended' && s.phase !== 'ended') this.finish();
        break;
      case 'history': {
        const old = new Map(s.chat.map((c) => [c.id, c.seq]));
        s.chat = (m.chat || []).map((c) => { if (!c.seq) c.seq = old.get(c.id) || ++s.seq; return c; });
        if (s.baseSeq == null) s.baseSeq = s.seq;   // what was already there when the console opened is not "unread"
        break;
      }
      case 'chat': s.chat = [...s.chat, this.numbered(m.msg)].slice(-300); break;
      case 'chatDel': s.chat = s.chat.filter((c) => c.id !== m.id); break;
      case 'count': s.watching = m.watching; if (typeof m.peak === 'number') s.peak = m.peak; break;
      case 'react': s.pulses = { love: s.pulses.love + (m.love || 0), like: s.pulses.like + (m.like || 0) }; break;
      case 'love': this.noteLove(m); break;
      case 'joined': this.pushEvent({ kind: 'joined', name: m.name, uid8: m.uid8, ...(m.via ? { via: m.via } : {}) }); break;
      case 'shared':
        if (typeof m.all === 'number') s.shares = Math.max(s.shares, m.all);
        this.pushEvent({ kind: 'shared', name: m.name, uid8: m.uid8, total: m.total });
        break;
      case 'listeners': s.listeners = { n: m.n | 0, good: m.good | 0, fair: m.fair | 0, poor: m.poor | 0, stalled: m.stalled | 0, silent: m.silent | 0, rcv: Date.now() }; break;
      case 'view': s.views += 1; break;
      case 'views': if (typeof m.n === 'number') s.views = Math.max(s.views, m.n); break;   // the real total from the database
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


  /* ---------- feed lines, counters, poems, show, markers ---------- */
  // Every line the host's feed shows (chat, requests, joined, love) gets an increasing number, so the unread badges can count.
  numbered(c) { if (!c.seq) c.seq = ++this.s.seq; return c; }

  pushEvent(e) {
    const s = this.s;
    s.events = [...s.events, { ...e, at: Date.now(), seq: ++s.seq }].slice(-200);
  }

  // Bursts of Love from one person within a moment become one line with the running total.
  noteLove(m) {
    const s = this.s;
    s.love = Math.max(s.love + (m.n || 0), typeof m.all === 'number' ? m.all : 0);
    s.lovePulse = { n: Math.max(1, m.n || 1), k: (s.lovePulse?.k || 0) + 1 };
    const last = s.events[s.events.length - 1];
    if (last && last.kind === 'love' && last.uid8 === m.uid8 && Date.now() - last.at < 2500) {
      s.events = [...s.events.slice(0, -1), { ...last, total: m.total, at: Date.now() }];
    } else this.pushEvent({ kind: 'love', name: m.name, uid8: m.uid8, total: m.total });
  }

  // A request seen for the first time gets a place in the feed (its later status changes only touch the Requests tab).
  noteRequests(list) {
    const s = this.s;
    if (!Array.isArray(list)) return;
    if (!this.seenReq) this.seenReq = new Set();
    for (const r of list) {
      if (this.seenReq.has(r.id)) continue;
      this.seenReq.add(r.id);
      s.events = [...s.events, { kind: 'request', id: r.id, name: r.name, uid8: String(r.uid || '').slice(0, 4), text: r.text, at: r.at || Date.now(), seq: ++s.seq }].slice(-200);
    }
  }

  // The views, Like and Love shown for this live start from what the database already has.
  async loadCounts(itemId) {
    try {
      const { data } = await sb.from('live_public').select('n_views,n_like').eq('id', itemId).maybeSingle();
      if (data && this.s.itemId === itemId) { this.s.views = Math.max(this.s.views, data.n_views || 0); this.s.pulses.like = Math.max(this.s.pulses.like, data.n_like || 0); this.emit(); }
    } catch { /* the counts then start from zero */ }
  }

  // Titles of the studio's poems, for the viewers' Request list. Titles only, never text.
  async sendPoems() {
    try {
      const rows = (await db.poems.toArray()).filter((p) => !p.deletedAt && (p.title || '').trim());   // every titled poem in the studio list
      rows.sort((a, b) => a.title.localeCompare(b.title));
      this.send({ t: 'poems', titles: rows.map((p) => p.title.trim().slice(0, 60)).slice(0, 40) });
    } catch { /* the list stays as it was */ }
  }

  // What viewers may see. The room shows it to them only while the title switch is on.
  setShow(patch) {
    this.s.show = { ...this.s.show, ...patch };
    this.sendShow();
    this.emit();
  }
  sendShow() { const { title, poem, playing } = this.s.show; this.send({ t: 'show', title: !!title, poem, playing }); }

  // How loud the recording is, twice a second. Saved on this laptop for the recap's waveform (every minute, and at the end).
  collectPeak(level) {
    this.peakMax = Math.max(this.peakMax || 0, level);
    this.peakTick = (this.peakTick || 0) + 1;
    if (this.peakTick % 5) return;
    (this.peaks ||= []).push(Math.round(this.peakMax * 100));
    this.peakMax = 0;
    if (this.peaks.length % 120 === 0 && this.s.captureId) this.savePeaks(this.s.captureId);
  }
  async savePeaks(id) { try { await db.meta.put({ key: `peaks:${id}`, value: this.peaks || [] }); } catch { /* the recap then draws a rougher waveform */ } }

  // The recap edits the whole list of markers at once.
  async setMarkers(list) {
    const s = this.s;
    s.markers = [...list].sort((a, b) => a.t - b.t).slice(0, 300).map((m) => ({ t: Math.max(0, Math.round(m.t)), label: String(m.label || '').slice(0, 80), kind: m.kind === 'poem' ? 'poem' : 'dead moment' }));
    this.emit();
    await sb.from('live_sessions').update({ markers: s.markers }).eq('item_id', s.itemId);
  }

  // A marker is a point in the recording (seconds from its start). Only while the recording runs.
  async addMarker({ label, kind = 'dead moment' }) {
    const s = this.s;
    if (s.phase !== 'live' || !this.rec) return;
    s.markers = [...s.markers, { t: Math.round(this.rec.seconds()), label: String(label || '').slice(0, 80), kind }];
    this.emit();
    await sb.from('live_sessions').update({ markers: s.markers }).eq('item_id', s.itemId);
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
    if (this.audio) { await this.audio.useDevice(deviceId); this.deviceId = this.audio.activeId || deviceId; this.s.inputMuted = this.audio.inputMuted; this.emit(); return this.audio; }
    const a = new LiveAudio();
    await a.start({ deviceId });
    this.deviceId = a.activeId || deviceId;
    a.onLost = () => { if (this.s.phase === 'live') this.set({ error: 'The audio input was lost. Plug it back in, then press Reconnect.', audioState: 'lost', inputMuted: true }); };
    a.onMute = (m) => { this.s.inputMuted = m; this.emit(); };
    a.onCtxState = (st) => { if (st !== 'running' && st !== 'closed') a.wake(); };
    this.audio = a;
    this.meter = setInterval(() => {
      this.s.level = a.level();
      if (this.rec) { this.s.recSeconds = this.rec.seconds(); this.collectPeak(this.s.level); }
      this.emit();
    }, 100);
    if (this.s.phase === 'idle') this.s.phase = 'ready';
    this.emit();
    return a;
  }

  async stopAudio() {
    clearInterval(this.meter); this.meter = null;
    this.stopHealth();
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
      this.peaks = []; this.peakMax = 0; this.peakTick = 0;
      s.captureId = this.rec.id;
      await this.publish(false);
      this.set({ phase: 'live', audioState: 'ok' });
      sb.from('live_sessions').update({ capture_id: this.rec.id }).eq('item_id', s.itemId).then(() => {});
      this.watchConnection();
      this.startHealth();
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
    const my = ++this.pubSeq;
    const pub = await publishAudio({ item: this.s.itemId, getToken, track: this.audio.track, kbps: settings.audioKbps, stereo: settings.stereo });
    // A newer attempt started while this one was still connecting (it was too slow): this one is thrown away.
    if (my !== this.pubSeq) { try { pub.close(); } catch { /* closed */ } throw new Error('Replaced by a newer attempt.'); }
    this.pub = pub;
    const ok = await this.ack(takeover);
    if (my !== this.pubSeq) { try { pub.close(); } catch { /* closed */ } throw new Error('Replaced by a newer attempt.'); }
    if (ok !== true) {
      try { pub.close(); } catch { /* closed */ }
      if (this.pub === pub) this.pub = null;
      throw new Error(ok === 'timeout' ? 'The live room did not answer. Check your connection.' : 'This live is already on air from another window.');
    }
  }

  // Tell the room which track is ours and wait for its answer (a state with our epoch, or an error).
  // Resolves true, false (another window holds the broadcast) or 'timeout' (no answer in 8 seconds).
  ack(takeover) {
    return new Promise((resolve) => {
      const stop = this.on(() => {
        const r = this.s.room;
        if (this.s.error.startsWith('This live is already')) { stop(); clearTimeout(t); resolve(false); }
        else if (r?.broadcaster?.online && r.broadcaster.sessionId === this.pub?.sessionId) { stop(); clearTimeout(t); resolve(true); }
      });
      const t = setTimeout(() => { stop(); resolve('timeout'); }, 8000);
      this.s.error = '';
      if (!this.send({ t: 'golive', sessionId: this.pub.sessionId, trackName: this.pub.trackName, takeover: !!takeover })) { stop(); clearTimeout(t); resolve('timeout'); }
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

  // Rebuilds the audio path while live: wake the audio engine, reopen the soundcard if it is stuck (or when forced),
  // publish again taking over the room, and watch the new connection. The recording keeps going the whole time.
  // A stuck attempt is given up after 30 seconds, so Reconnect always works.
  async retryAudio(force = false) {
    if (this.s.phase !== 'live') return;
    if (this.repub && !force && Date.now() - this.repub < 30000) return;
    const mine = this.repub = Date.now();
    this.set({ audioState: 'connecting', error: '' });
    try {
      await withTimeout((async () => {
        try { this.pub?.close(); } catch { /* closed */ }
        this.pub = null;
        if (!this.audio) throw new Error('The soundcard is not open. Choose an input, then press Reconnect.');
        await this.audio.wake();
        const t = this.audio.inputTrack;
        if (force || !t || t.readyState !== 'live' || t.muted) {
          await this.audio.useDevice(this.deviceId, { reopen: true });
          this.deviceId = this.audio.activeId || this.deviceId;
          this.s.inputMuted = this.audio.inputMuted;
        }
        if (!this.room) throw new Error('Not connected to the live room.');
        await this.publish(true);
      })(), 30000, 'Reconnecting took too long. Trying again.');
      this.watchConnection();
      this.lastPackets = null; this.noSendTicks = 0; this.offTicks = 0;
      this.set({ audioState: 'ok' });
    } catch (e) {
      this.pubSeq++;                       // anything still connecting from this attempt is now thrown away
      try { this.pub?.close(); } catch { /* closed */ }
      this.pub = null;
      this.set({ audioState: 'lost', error: friendly(e) });
      setTimeout(() => { if (this.repub === mine) this.repub = 0; if (this.s.phase === 'live' && this.s.audioState === 'lost') this.retryAudio(); }, 5000);
      return;
    }
    if (this.repub === mine) this.repub = 0;
  }

  // The Reconnect button: reconnect the room if it dropped, then rebuild the audio path from the soundcard up.
  async reconnect() {
    if (this.s.phase !== 'live') return;
    this.room?.hello();
    await this.retryAudio(true);
  }

  /* ---------- health: what listeners are getting ---------- */
  startHealth() {
    this.stopHealth();
    this.lastPackets = null; this.noSendTicks = 0; this.mutedTicks = 0; this.offTicks = 0;
    this.healthTimer = setInterval(() => { this.healthTick().catch(() => {}); }, 2000);
  }
  stopHealth() { clearInterval(this.healthTimer); this.healthTimer = null; }

  async healthTick() {
    const s = this.s;
    if (s.phase !== 'live') return;
    const a = this.audio;
    if (a) { await a.wake(); s.inputMuted = a.inputMuted; }
    s.silentFor = s.level < 0.02 ? s.silentFor + 2 : 0;
    this.mutedTicks = s.inputMuted ? this.mutedTicks + 1 : 0;

    // Are packets leaving this laptop?
    const pc = this.pub?.pc;
    if (pc && s.audioState === 'ok') {
      let packets = null;
      try { (await pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && (r.kind || r.mediaType) === 'audio') packets = r.packetsSent; }); } catch { /* keep what we knew */ }
      if (typeof packets === 'number') {
        s.sending = this.lastPackets == null ? null : packets > this.lastPackets;
        this.noSendTicks = s.sending === false ? this.noSendTicks + 1 : 0;
        this.lastPackets = packets;
      }
    } else { s.sending = null; this.lastPackets = null; this.noSendTicks = 0; }

    // Does the room still list us as the broadcaster?
    const r = s.room;
    const roomOff = s.conn === 'open' && s.audioState === 'ok' && r?.status === 'live' && r.broadcaster && !r.broadcaster.online;
    this.offTicks = roomOff ? this.offTicks + 1 : 0;
    if (this.offTicks >= 2 && this.pub && Date.now() - this.lastAnnounce > 6000) {
      this.lastAnnounce = Date.now();
      this.send({ t: 'broadcaster', sessionId: this.pub.sessionId, trackName: this.pub.trackName, takeover: true });   // cheap first: say again that we are here
    }

    // Heal by itself: an input that stays silent at the device, packets that stop leaving, or a room that still
    // says offline after being told. At most once every 20 seconds.
    const stuck = this.mutedTicks >= 3 || this.noSendTicks >= 3 || this.offTicks >= 5;
    if (stuck && s.audioState === 'ok' && Date.now() - this.lastAuto > 20000) { this.lastAuto = Date.now(); this.retryAudio(true); }
    this.emit();
  }

  // One line for the header badge: { level: 'good' | 'warn' | 'bad', text, hint }. Null when not on air.
  health() {
    const s = this.s;
    if (s.phase !== 'live') return null;
    const L = s.listeners && Date.now() - s.listeners.rcv < 45000 ? s.listeners : null;
    const bad = (text, hint) => ({ level: 'bad', text, hint });
    const warn = (text, hint) => ({ level: 'warn', text, hint });
    if (s.conn !== 'open') return bad("Listeners can't hear you: no room connection", 'This laptop lost its connection to the live room. It reconnects by itself; press Reconnect to rebuild the audio too.');
    if (s.audioState === 'connecting') return warn('Reconnecting your audio…', 'The audio connection is being rebuilt. The recording keeps going.');
    if (s.audioState === 'lost') return bad("Listeners can't hear you: audio is down", 'The audio connection is down. Press Reconnect.');
    if (s.inputMuted) return bad("Listeners can't hear you: input silent", 'The soundcard stopped sending sound. Press Reconnect to reopen it.');
    if (s.sending === false) return bad("Listeners can't hear you: nothing is leaving this laptop", 'No audio packets are being sent. Press Reconnect.');
    if (s.room?.broadcaster && !s.room.broadcaster.online) return bad("Listeners can't hear you: the room has no broadcast", 'The live room does not list you as on air. Press Reconnect.');
    if (L && L.n >= 3 && (L.stalled + (s.silentFor < 6 ? L.silent : 0)) / L.n >= 0.6) return bad(`Listeners can't hear you: ${Math.max(L.stalled, L.silent)} of ${L.n} get no sound`, 'Most listeners get no sound although your side looks fine. Press Reconnect.');
    if (L && L.stalled + (s.silentFor < 6 ? L.silent : 0) >= 1) return warn(`${Math.max(L.stalled, L.silent)} of ${L.n} ${L.n === 1 ? 'listener gets' : 'listeners get'} no sound`, L.n <= 2 ? 'With so few listeners this may be their own connection.' : 'A few listeners are affected, usually their own connection.');
    if (L && L.poor >= Math.max(1, Math.ceil(L.n * 0.4))) return warn(`${L.poor} of ${L.n} listeners have a weak connection`, 'Their connection is weak; yours looks fine.');
    if (s.silentFor >= 20) return warn(`No sound on your input for ${Math.floor(s.silentFor)} s`, 'The input level has been silent. Fine during a pause; check the soundcard if not.');
    return { level: 'good', text: L ? `Listeners hear you (${L.n} listening)` : 'Sending audio', hint: L ? 'Everything looks fine on your side and for listeners.' : 'Audio is leaving this laptop and the room lists you as on air. No listener reports yet.' };
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
    if (this.rec) { try { id = await this.rec.stop(); } catch (e) { s.error = friendly(e); } this.rec = null; if (id) await this.savePeaks(id); }
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
  if (e?.name === 'NotReadableError') return 'The soundcard is busy or stuck. Unplug it, plug it back in, then press Reconnect.';
  return e?.detail ? `${m} (${e.detail})` : m;
};

export const engine = new LiveEngine();

// Warn before the tab is closed while on air.
window.addEventListener('beforeunload', (e) => { if (engine.active) { e.preventDefault(); e.returnValue = ''; } });
