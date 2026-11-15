// LiveRoom: one Durable Object per live session. It is the "room".
//
// It holds everything that changes while you are live: status, title, pinned message, chat, the request
// queue, mutes, slow mode, viewer mode, and which SFU track carries the audio. It enforces every rule
// (viewer mode, slow mode, mutes, limits) on the server, so a modified browser cannot get around them.
//
// Browsers connect with a WebSocket at /live/ws?item=<id> and first send {t:'hello', token}.
// Chat is saved to the `comments` table in batches (so it shows under the replay), and the request log
// is saved to live_sessions when the live ends. Both need the SUPABASE_SERVICE_KEY secret.
import { DEFAULT_SETTINGS, cleanSettings, publicSettings } from '../../site/shared/live-settings.js';

const KEEP_CHAT = 300;        // messages kept in the room
const FLUSH_MS = 15000;       // how often chat is saved while live
const HELLO_MS = 15000;       // a socket that never says hello is closed after this
const COUNT_MS = 1500;        // viewer count is sent at most this often
const REACT_MS = 1000;        // reaction pulses are batched into one message per second
const MAX_REQUESTS = 200;

const fresh = () => ({
  itemId: null,
  status: 'idle',             // idle -> live -> ended. Ended is final: a new live is a new session.
  settings: { ...DEFAULT_SETTINGS },
  title: '',
  pinned: null,               // { text, name }
  chatPaused: false,
  muted: {},                  // uid -> true
  broadcaster: { sessionId: null, trackName: null, epoch: 0, online: false },
  startedAt: null,
  endedAt: null,
  peak: 0,
  requests: [],               // { id, uid, name, kind, text, status, at }
});

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class LiveRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.st = fresh();
    this.chat = [];
    this.rate = new Map();         // uid -> recent message times
    this.lastChat = new Map();     // uid -> last chat time (slow mode)
    this.tokens = new Map();       // token -> { user, until }
    this.pulses = { love: 0, like: 0 };
    this.pulseTimer = null;
    this.countTimer = null;
    this.flushing = false;
    ctx.blockConcurrencyWhile(async () => {
      const [st, chat] = await Promise.all([ctx.storage.get('st'), ctx.storage.get('chat')]);
      if (st) this.st = { ...fresh(), ...st, settings: cleanSettings(st.settings) };
      if (Array.isArray(chat)) this.chat = chat;
    });
  }

  /* ---------- entry points ---------- */
  async fetch(request) {
    const url = new URL(request.url);
    const itemId = request.headers.get('x-item-id');
    if (itemId && this.st.itemId !== itemId) { this.st.itemId = itemId; await this.save(); }

    if (url.pathname === '/info') {
      const s = this.st;
      return Response.json({ status: s.status, mode: s.settings.mode, broadcaster: { ...s.broadcaster } });
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ hello: false, at: Date.now() });
      await this.armAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 4000) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const att = ws.deserializeAttachment() || {};
    if (m.t === 'hello') return this.onHello(ws, m);
    if (!att.hello) return;
    if (!att.owner && !this.allow(att.uid)) return this.send(ws, { t: 'err', code: 'rate' });
    try {
      if (att.owner && att.console && (await this.onOwner(ws, att, m))) return;
      await this.onViewer(ws, att, m);
    } catch (e) {
      console.warn('live message failed', m.t, e?.message);
      this.send(ws, { t: 'err', code: 'server' });
    }
  }

  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }

  async alarm() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a?.hello && now - (a?.at || 0) > HELLO_MS) { try { ws.close(4400, 'No hello'); } catch { /* already closed */ } }
    }
    if (this.st.status === 'live') await this.flush();
    await this.armAlarm();
  }

  /* ---------- who is connecting ---------- */
  async verify(token) {
    if (!token || typeof token !== 'string') return null;
    const hit = this.tokens.get(token);
    if (hit && hit.until > Date.now()) return hit.user;
    const r = await fetch(`${this.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: this.env.SUPABASE_ANON_KEY },
    });
    if (!r.ok) return null;
    const user = await r.json();
    if (this.tokens.size > 500) this.tokens.clear();
    this.tokens.set(token, { user, until: Date.now() + 5 * 60 * 1000 });
    return user;
  }

  async onHello(ws, m) {
    const user = await this.verify(m.token);
    if (!user) { this.send(ws, { t: 'err', code: 'auth' }); try { ws.close(4401, 'Not signed in'); } catch { /* closed */ } return; }
    const owner = user.id === this.env.OWNER_USER_ID;
    const anon = !!user.is_anonymous;
    const name = owner
      ? this.st.settings.hostName
      : anon ? `Guest ${user.id.slice(0, 4)}`
        : clean(user.user_metadata?.full_name?.split(' ')[0] || (user.email || '').split('@')[0] || 'Viewer', 30);
    const old = ws.deserializeAttachment() || {};
    const att = { hello: true, at: old.at || Date.now(), uid: user.id, name, anon, owner, console: owner && m.console === true, live: !!old.live };
    ws.serializeAttachment(att);
    this.send(ws, this.view(att));
    this.sendHistory(ws, att);
    this.scheduleCount();
    await this.armAlarm();
  }

  allow(uid) {
    const now = Date.now();
    const list = (this.rate.get(uid) || []).filter((t) => now - t < 10000);
    if (list.length >= 20) { this.rate.set(uid, list); return false; }
    list.push(now);
    this.rate.set(uid, list);
    if (this.rate.size > 2000) this.rate.clear();
    return true;
  }

  /* ---------- what each person is allowed and shown ---------- */
  isBlocked(att) { return this.st.settings.mode === 'login' && att.anon && !att.owner; }

  caps(att) {
    const s = this.st;
    const set = s.settings;
    const live = s.status === 'live';
    let chat = 'ok';
    if (att.owner) chat = s.status === 'ended' ? 'closed' : 'ok';
    else if (!set.chatEnabled) chat = 'off';
    else if (!live) chat = 'closed';
    else if (s.chatPaused) chat = 'paused';
    else if (s.muted[att.uid]) chat = 'muted';
    else if (att.anon && !set.chatGuests) chat = 'login';
    const guestOk = !(att.anon && !set.requestsGuests);
    const base = !live && !att.owner ? 'closed' : !guestOk ? 'login' : 'ok';
    return {
      chat,
      request: set.requestsEnabled ? base : 'off',
      question: set.questionsEnabled ? base : 'off',
      react: set.reactionsEnabled ? (live || att.owner ? 'ok' : 'closed') : 'off',
    };
  }

  watching() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.hello && !a.owner && !this.isBlocked(a)) ids.add(a.uid);
    }
    return ids.size;
  }

  requestsFor(att) {
    const set = this.st.settings;
    let list = this.st.requests.filter((r) => r.status !== 'dismissed');
    if (!att.owner && !set.requestsVisible) list = list.filter((r) => r.uid === att.uid);
    return list.map((r) => ({ id: r.id, name: r.name, kind: r.kind, text: r.text, status: r.status, at: r.at, mine: r.uid === att.uid, ...(att.owner ? { uid: r.uid } : {}) }));
  }

  view(att) {
    const s = this.st;
    const set = s.settings;
    const v = { t: 'state', status: s.status, title: s.title, mode: set.mode, startedAt: s.startedAt, endedAt: s.endedAt, now: Date.now(), settings: publicSettings(set) };
    if (att.owner) { v.ownerSettings = set; v.muted = Object.keys(s.muted); v.peak = s.peak; v.broadcaster = { ...s.broadcaster }; }
    if (this.isBlocked(att)) { v.you = { uid: att.uid, name: att.name, blocked: 'login' }; return v; }
    v.pinned = s.pinned;
    v.chatPaused = s.chatPaused;
    v.slowSeconds = set.slowSeconds;
    v.audio = { epoch: s.broadcaster.epoch, online: s.broadcaster.online };
    if (set.showWatching || att.owner) v.watching = this.watching();
    v.requests = this.requestsFor(att);
    v.you = { uid: att.uid, name: att.name, owner: att.owner, anon: att.anon, ...this.caps(att) };
    return v;
  }

  sendHistory(ws, att) {
    if (this.isBlocked(att)) return;
    const n = att.owner ? KEEP_CHAT : this.st.settings.chatHistory;
    const list = n > 0 ? this.chat.filter((c) => !c.del).slice(-n) : [];
    this.send(ws, { t: 'history', chat: list.map((c) => this.pub(c)) });
  }

  pub(c) { return { id: c.id, name: c.name, text: c.text, at: c.at, host: !!c.host, uid8: c.uid.slice(0, 4) }; }

  /* ---------- sending ---------- */
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* the socket is closing */ } }

  each(fn) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.hello) fn(ws, att);
    }
  }

  pushState() { this.each((ws, att) => this.send(ws, this.view(att))); }

  scheduleCount() {
    if (this.countTimer) return;
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      const n = this.watching();
      if (n > this.st.peak) { this.st.peak = n; this.save().catch(() => {}); }
      this.each((ws, att) => {
        if (this.isBlocked(att)) return;
        if (this.st.settings.showWatching || att.owner) this.send(ws, { t: 'count', watching: n, ...(att.owner ? { peak: this.st.peak } : {}) });
      });
    }, COUNT_MS);
  }

  schedulePulses() {
    if (this.pulseTimer) return;
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = null;
      const msg = { t: 'react', love: this.pulses.love, like: this.pulses.like };
      this.pulses = { love: 0, like: 0 };
      this.each((ws, att) => { if (!this.isBlocked(att)) this.send(ws, msg); });
    }, REACT_MS);
  }

  /* ---------- storage ---------- */
  async save() { await this.ctx.storage.put({ st: this.st, chat: this.chat }); }

  async armAlarm() {
    const needed = this.st.status === 'live' || this.ctx.getWebSockets().some((w) => !w.deserializeAttachment()?.hello);
    if (!needed) return;
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
  }

  async sb(method, path, body, prefer) {
    const key = this.env.SUPABASE_SERVICE_KEY;
    if (!key) return null; // not configured: the live still works, chat just is not saved
    try {
      return await fetch(`${this.env.SUPABASE_URL}/rest/v1/${path}`, {
        method,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      console.warn('Supabase call failed', e?.message);
      return null;
    }
  }

  // Saves chat that has not been saved yet. Safe to repeat: rows are keyed by message id.
  async flush() {
    if (this.flushing || !this.st.itemId) return;
    const pending = this.chat.filter((m) => !m.sent && !m.del);
    if (!pending.length) return;
    this.flushing = true;
    try {
      const rows = pending.map((m) => ({
        id: m.id, item_id: this.st.itemId, user_id: m.uid, nickname: (m.name || 'Guest').slice(0, 30),
        body: m.text.slice(0, 500), created_at: new Date(m.at).toISOString(),
      }));
      const r = await this.sb('POST', 'comments?on_conflict=id', rows, 'resolution=ignore-duplicates,return=minimal');
      if (r && r.ok) { for (const m of pending) m.sent = true; await this.save(); }
      else if (r) console.warn('Saving chat failed', r.status);
    } finally { this.flushing = false; }
  }

  /* ---------- viewers ---------- */
  async onViewer(ws, att, m) {
    const s = this.st;
    const set = s.settings;
    if (this.isBlocked(att)) return this.send(ws, { t: 'err', code: 'login' });

    if (m.t === 'chat') {
      const caps = this.caps(att);
      if (caps.chat !== 'ok') return this.send(ws, { t: 'err', code: `chat-${caps.chat}` });
      const text = clean(m.text, set.chatMaxLength);
      if (!text) return;
      if (!att.owner && set.slowSeconds > 0) {
        const wait = set.slowSeconds * 1000 - (Date.now() - (this.lastChat.get(att.uid) || 0));
        if (wait > 0) return this.send(ws, { t: 'err', code: 'slow', wait: Math.ceil(wait / 1000) });
      }
      this.lastChat.set(att.uid, Date.now());
      if (this.lastChat.size > 2000) this.lastChat.clear();
      const msg = { id: crypto.randomUUID(), uid: att.uid, name: att.name, text, at: Date.now(), host: att.owner ? 1 : 0 };
      this.chat.push(msg);
      if (this.chat.length > KEEP_CHAT) this.chat.splice(0, this.chat.length - KEEP_CHAT);
      await this.save();
      const out = { t: 'chat', msg: this.pub(msg) };
      this.each((w, a) => { if (!this.isBlocked(a)) this.send(w, out); });
      return;
    }

    if (m.t === 'react') {
      if (this.caps(att).react !== 'ok') return;
      this.pulses[m.type === 'love' ? 'love' : 'like'] += 1;
      this.schedulePulses();
      return;
    }

    if (m.t === 'request') {
      const kind = m.kind === 'question' ? 'question' : 'request';
      const caps = this.caps(att);
      const can = kind === 'question' ? caps.question : caps.request;
      if (can !== 'ok') return this.send(ws, { t: 'err', code: `${kind}-${can}` });
      const text = clean(m.text, 200);
      if (!text) return;
      const open = s.requests.filter((r) => r.uid === att.uid && (r.status === 'queued' || r.status === 'reading')).length;
      if (!att.owner && open >= set.requestsPerViewer) return this.send(ws, { t: 'err', code: 'request-limit' });
      s.requests.push({ id: crypto.randomUUID(), uid: att.uid, name: att.name, kind, text, status: 'queued', at: Date.now() });
      if (s.requests.length > MAX_REQUESTS) s.requests.splice(0, s.requests.length - MAX_REQUESTS);
      await this.save();
      this.pushState();
      this.send(ws, { t: 'ok', what: kind });
    }
  }

  /* ---------- the host (laptop console). Returns true when the message was handled. ---------- */
  async onOwner(ws, att, m) {
    const s = this.st;
    switch (m.t) {
      case 'settings': {
        const prev = s.settings;
        s.settings = cleanSettings(m.settings, m.replace ? DEFAULT_SETTINGS : prev);
        await this.save();
        this.pushState();
        return true;
      }
      case 'title':
        s.title = clean(m.text, 120);
        await this.save(); this.pushState();
        return true;
      case 'pin': {
        if (m.msgId) {
          const c = this.chat.find((x) => x.id === m.msgId && !x.del);
          s.pinned = c ? { text: c.text, name: c.name } : null;
        } else if (m.text) s.pinned = { text: clean(m.text, 300), name: s.settings.hostName };
        else s.pinned = null;
        await this.save(); this.pushState();
        return true;
      }
      case 'pause':
        s.chatPaused = !!m.on;
        await this.save(); this.pushState();
        return true;
      case 'mute': {
        const uid = this.resolveUid(String(m.uid || ''));
        if (!uid) return this.send(ws, { t: 'err', code: 'no-such-id' }), true;
        if (m.on === false) delete s.muted[uid]; else s.muted[uid] = true;
        await this.save(); this.pushState();
        return true;
      }
      case 'delchat': {
        const c = this.chat.find((x) => x.id === m.id);
        if (!c) return true;
        c.del = true;
        if (c.sent) await this.sb('DELETE', `comments?id=eq.${c.id}`, null, 'return=minimal');
        if (s.pinned && s.pinned.text === c.text) s.pinned = null;
        await this.save();
        this.each((w, a) => { if (!this.isBlocked(a)) this.send(w, { t: 'chatDel', id: c.id }); });
        this.pushState();
        return true;
      }
      case 'req': {
        const r = s.requests.find((x) => x.id === m.id);
        if (!r) return true;
        if (m.action === 'reading') {
          for (const o of s.requests) if (o.status === 'reading') o.status = 'done';
          r.status = 'reading';
        } else if (m.action === 'done') r.status = 'done';
        else if (m.action === 'dismiss') r.status = 'dismissed';
        else if (m.action === 'queue') r.status = 'queued';
        else if (m.action === 'up') {
          s.requests.splice(s.requests.indexOf(r), 1);
          const first = s.requests.findIndex((o) => o.status === 'queued');
          s.requests.splice(first < 0 ? s.requests.length : first, 0, r);
        }
        await this.save(); this.pushState();
        return true;
      }
      case 'golive':
      case 'broadcaster':
        return await this.setBroadcaster(ws, att, m);
      case 'offline':
        if (att.live) { s.broadcaster.online = false; await this.save(); this.pushState(); }
        return true;
      case 'end':
        await this.endSession();
        return true;
      default:
        return false;
    }
  }

  resolveUid(q) {
    if (/^[0-9a-f-]{36}$/.test(q)) return q;
    const short = q.replace(/^guest\s*/i, '').toLowerCase();
    if (short.length < 4) return null;
    for (const c of [...this.chat].reverse()) if (c.uid.startsWith(short)) return c.uid;
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a?.uid?.startsWith(short)) return a.uid; }
    return null;
  }

  async setBroadcaster(ws, att, m) {
    const s = this.st;
    if (s.status === 'ended') return this.send(ws, { t: 'err', code: 'ended' }), true;
    if (m.t === 'broadcaster' && s.status !== 'live') return true;
    if (!ID_RE.test(String(m.sessionId || '')) || !ID_RE.test(String(m.trackName || ''))) return this.send(ws, { t: 'err', code: 'bad-track' }), true;
    // One broadcaster per room.
    for (const w of this.ctx.getWebSockets()) {
      if (w === ws) continue;
      const a = w.deserializeAttachment();
      if (!a?.live) continue;
      if (!m.takeover) return this.send(ws, { t: 'err', code: 'already-live' }), true;
      this.send(w, { t: 'taken' });
      w.serializeAttachment({ ...a, live: false });
    }
    s.broadcaster = { sessionId: m.sessionId, trackName: m.trackName, epoch: s.broadcaster.epoch + 1, online: true };
    const first = s.status !== 'live';
    if (first) { s.status = 'live'; s.startedAt = Date.now(); }
    ws.serializeAttachment({ ...att, live: true });
    await this.save();
    this.pushState();
    await this.armAlarm();
    if (first) await this.sb('PATCH', `live_sessions?item_id=eq.${s.itemId}`, { state: 'live', started_at: new Date(s.startedAt).toISOString() }, 'return=minimal');
    return true;
  }

  async endSession() {
    const s = this.st;
    if (s.status === 'ended') return;
    s.status = 'ended';
    s.endedAt = Date.now();
    s.broadcaster = { ...s.broadcaster, online: false };
    this.each((w, a) => { if (a.live) w.serializeAttachment({ ...a, live: false }); });
    await this.save();
    this.pushState();
    await this.flush();
    const log = s.requests.map((r) => ({ name: r.name, kind: r.kind, text: r.text, status: r.status, at: r.at }));
    await this.sb('PATCH', `live_sessions?item_id=eq.${s.itemId}`,
      { state: 'ended', ended_at: new Date(s.endedAt).toISOString(), peak_viewers: s.peak, requests: log }, 'return=minimal');
  }

  async gone(ws) {
    const att = ws.deserializeAttachment();
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    if (att?.live && this.st.status === 'live') {
      const still = this.ctx.getWebSockets().some((w) => w !== ws && w.deserializeAttachment()?.live);
      if (!still) { this.st.broadcaster.online = false; await this.save(); this.pushState(); }
    }
    this.scheduleCount();
  }
}
