// LiveRoom: one Durable Object per live session. It is the "room".
//
// It holds everything that changes while you are live: status, title, pinned message, chat, the request
// queue, mutes, slow mode, viewer mode, and which SFU track carries the audio. It enforces every rule
// (viewer mode, slow mode, mutes, limits) on the server, so a modified browser cannot get around them.
//
// Browsers connect with a WebSocket at /live/ws?item=<id> and first send {t:'hello', token}.
// Chat is saved to the `comments` table in batches (so it shows under the replay), each person's Love taps are
// saved to `live_love` on the same schedule, and the request log is saved to live_sessions when the live ends.
// When the live ends, the list of people who joined (name, join time, messages, Love given) is saved to `live_log`
// (migration 007). Chat itself is already in `comments` and Love in `live_love`, so neither is copied again.
// All of that needs the SUPABASE_SERVICE_KEY secret.
import { DEFAULT_SETTINGS, cleanSettings, publicSettings } from '../../site/shared/live-settings.js';

const KEEP_CHAT = 300;        // messages kept in the room
const FLUSH_MS = 15000;       // how often chat is saved while live
const HELLO_MS = 15000;       // a socket that never says hello is closed after this
const COUNT_MS = 1500;        // viewer count is sent at most this often
const REACT_MS = 1000;        // reaction pulses are batched into one message per second
const MAX_REQUESTS = 200;
const LOVE_BATCH = 12;        // taps accepted in one love message (the page batches about every 0.4 s)
const LOVE_GAP_MS = 250;      // love messages from one person closer than this are dropped without an error
const MAX_LOVERS = 5000;      // people whose love totals are kept in the room
const MAX_JOINED = 5000;      // people remembered for "joined" notices
const MAX_SHARERS = 2000;     // people whose shares are counted in the room
const SHARE_GAP_MS = 3000;    // share messages from one person closer than this are dropped without an error
const MAX_SHARES_EACH = 100;  // shares counted per person in one live
const MAX_POEMS = 40;         // poem titles the host can offer in the Request list
const POEM_CHARS = 60;

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
  requests: [],               // { id, uid, name, kind, text, status, at }. kind is always 'request'.
  love: {},                   // uid -> { name, taps, dirty }  Love taps this live, merged per person
  joined: {},                 // uid -> { n: name, a: first seen (ms), g: 1 for a guest, m: messages }  (older lives stored 1)
  poems: [],                  // titles of poems with more than 5 stanzas, for the Request list
  shared: {},                 // uid -> { n: name, c: times shared, b: people who joined through their link }  (host console only)
  show: { on: false, poem: '', playing: '' },   // what viewers may see: poem title and what is playing
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
    this.lastLove = new Map();     // uid -> last love message time
    this.lastShare = new Map();    // uid -> last share message time
    this.viewed = new Set();       // uids whose view was already sent to the database in this room
    this.lovingNow = false;
    this.saveTimer = null;
    this.pulseTimer = null;
    this.countTimer = null;
    this.flushing = false;
    ctx.blockConcurrencyWhile(async () => {
      const [st, chat] = await Promise.all([ctx.storage.get('st'), ctx.storage.get('chat')]);
      if (st) {
        this.st = { ...fresh(), ...st, settings: cleanSettings(st.settings) };
        this.st.requests = (this.st.requests || []).filter((r) => r.kind !== 'question').map((r) => ({ ...r, kind: 'request' }));
      }
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
      return Response.json({ status: s.status, mode: 'login', broadcaster: { ...s.broadcaster } });
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
    if (m.t === 'love') { if (!this.loveAllow(att.uid)) return; }
    else if (!att.owner && !this.allow(att.uid)) return this.send(ws, { t: 'err', code: 'rate' });
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
    if (this.st.status === 'live') { await this.flush(); await this.flushLove(); }
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
        : clean(user.user_metadata?.display_name || user.user_metadata?.full_name?.split(' ')[0] || (user.email || '').split('@')[0] || 'Viewer', 30);
    const old = ws.deserializeAttachment() || {};
    const att = { hello: true, at: old.at || Date.now(), uid: user.id, name, anon, owner, console: owner && m.console === true, live: !!old.live };
    ws.serializeAttachment(att);
    this.send(ws, this.view(att));
    this.sendHistory(ws, att);
    if (!this.isBlocked(att)) {
      this.send(ws, { t: 'poems', titles: this.st.poems });
      this.send(ws, this.showFor(att));
      this.noteJoin(att, m.ref);
    }
    this.scheduleCount();
    await this.armAlarm();
    if (owner && att.console) this.viewsTotal().then((n) => { if (n != null) this.send(ws, { t: 'views', n }); });   // a console that opens later starts from the real total
    if (!owner && !this.isBlocked(att)) await this.recordView(att);
  }

  // A person's first arrival during the live is shown to the host once. Rejoining adds nothing here.
  // When they came through someone's invite link (ref = the first 8 characters of that person's account id), the host
  // line says who invited them and the inviter gets a thank-you. Only the host console ever sees a join.
  noteJoin(att, ref) {
    if (att.owner || this.st.status !== 'live' || this.st.joined[att.uid]) return;
    if (Object.keys(this.st.joined).length >= MAX_JOINED) return;
    this.st.joined[att.uid] = { n: att.name, a: Date.now(), g: att.anon ? 1 : 0, m: 0 };
    const inviter = this.inviterFor(ref, att.uid);
    if (inviter) inviter.row.b = (inviter.row.b || 0) + 1;
    this.saveSoon();
    this.toHost({ t: 'joined', name: att.name, uid8: att.uid.slice(0, 4), ...(inviter ? { via: inviter.row.n, viaUid8: inviter.uid.slice(0, 4) } : {}) });
    if (inviter) this.each((w, a) => { if (a.uid === inviter.uid && !a.owner) this.send(w, { t: 'thanks', name: att.name }); });
  }

  // The person a ref points to: someone who shared, or at least joined, this live. A bad, unknown, ambiguous or own ref gives null.
  inviterFor(ref, uid) {
    if (typeof ref !== 'string' || !/^[0-9a-f]{8}$/i.test(ref)) return null;
    const key = ref.toLowerCase();
    const hits = new Set();
    for (const k of Object.keys(this.st.shared)) if (k !== uid && k.toLowerCase().startsWith(key)) hits.add(k);
    for (const k of Object.keys(this.st.joined)) if (k !== uid && k.toLowerCase().startsWith(key)) hits.add(k);
    if (hits.size !== 1) return null;
    const id = [...hits][0];
    let row = this.st.shared[id];
    if (!row) {
      if (Object.keys(this.st.shared).length >= MAX_SHARERS) return null;
      const j = this.st.joined[id];
      row = this.st.shared[id] = { n: clean((j && typeof j === 'object' && j.n) || 'Viewer', 30), c: 0, b: 0 };
    }
    return { uid: id, row };
  }

  shareTotal() { let n = 0; for (const k in this.st.shared) n += this.st.shared[k].c || 0; return n; }

  shareAllow(uid) {
    const now = Date.now();
    if (now - (this.lastShare.get(uid) || 0) < SHARE_GAP_MS) return false;
    this.lastShare.set(uid, now);
    if (this.lastShare.size > 2000) this.lastShare.clear();
    return true;
  }

  // Counts a chat message for the viewer log (the room keeps only the last KEEP_CHAT lines, so it cannot be counted from those).
  countMessage(att) {
    if (att.owner) return;
    const j = this.st.joined[att.uid];
    if (j && typeof j === 'object') { j.m = (j.m || 0) + 1; this.saveSoon(); }
  }

  // Counts the view in the database (once per account, same rule as every other item) and tells the host
  // only when it was a new view. Needs the SUPABASE_SERVICE_KEY secret; without it nothing is counted here.
  async recordView(att) {
    const item = this.st.itemId;
    if (!item || this.viewed.has(att.uid)) return;
    if (this.viewed.size > 5000) this.viewed.clear();
    this.viewed.add(att.uid);
    const r = await this.sb('POST', 'rpc/record_view_for', { p_item: item, p_user: att.uid });
    if (!r || !r.ok) { this.viewed.delete(att.uid); return; }
    let isNew = false;
    try { isNew = (await r.json()) === true; } catch { /* not a boolean */ }
    if (isNew) this.toHost({ t: 'view' });
    // The public page also records the view the moment it loads, often before this room does, and then this call is
    // not "new". So the host always gets the real total from the database, whoever recorded it.
    const n = await this.viewsTotal();
    if (n != null) this.toHost({ t: 'views', n });
  }

  // The live's view count as saved in the database (null when it cannot be read).
  async viewsTotal() {
    const item = this.st.itemId;
    if (!item) return null;
    try {
      const r = await this.sb('GET', `counters?item_id=eq.${item}&select=n_views`);
      if (!r || !r.ok) return null;
      const rows = await r.json();
      return Array.isArray(rows) && rows[0] ? Number(rows[0].n_views) || 0 : 0;
    } catch { return null; }
  }

  loveAllow(uid) {
    const now = Date.now();
    if (now - (this.lastLove.get(uid) || 0) < LOVE_GAP_MS) return false;
    this.lastLove.set(uid, now);
    if (this.lastLove.size > 2000) this.lastLove.clear();
    return true;
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
  // Every live needs a real account: a leftover guest session is treated as signed out.
  isBlocked(att) { return att.anon && !att.owner; }

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
    const base = !live && !att.owner ? 'closed' : 'ok';
    return {
      chat,
      request: set.requestsEnabled ? base : 'off',
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
    return list.map((r) => ({ id: r.id, name: r.name, kind: 'request', text: r.text, status: r.status, at: r.at, mine: r.uid === att.uid, ...(att.owner ? { uid: r.uid } : {}) }));
  }

  view(att) {
    const s = this.st;
    const set = s.settings;
    const v = { t: 'state', status: s.status, title: s.title, mode: 'login', startedAt: s.startedAt, endedAt: s.endedAt, now: Date.now(), settings: publicSettings(set) };
    if (att.owner) { v.ownerSettings = set; v.muted = Object.keys(s.muted); v.peak = s.peak; v.broadcaster = { ...s.broadcaster }; v.shares = this.shareTotal(); }
    if (this.isBlocked(att)) { v.you = { uid: att.uid, name: att.name, blocked: 'login' }; return v; }
    v.pinned = s.pinned;
    v.chatPaused = s.chatPaused;
    v.slowSeconds = set.slowSeconds;
    v.audio = { epoch: s.broadcaster.epoch, online: s.broadcaster.online };
    if (set.showWatching || att.owner) v.watching = this.watching();
    v.requests = this.requestsFor(att);
    if (att.owner || set.showReactionCounts) v.loveTotal = this.loveTotal();
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

  // Only the host's laptop console receives these.
  toHost(obj) { this.each((ws, att) => { if (att.owner && att.console) this.send(ws, obj); }); }

  // The title and "playing" text reach viewers only while the host has show-title on.
  showFor(att) {
    const sh = this.st.show;
    const open = att.owner || sh.on;
    return { t: 'show', on: !!sh.on, poem: open ? sh.poem : '', playing: open ? sh.playing : '' };
  }

  loveTotal() { let n = 0; for (const k in this.st.love) n += this.st.love[k].taps; return n; }

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

  // Taps and joins can arrive many times a second, so they are saved together a moment later.
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save().catch(() => {}); }, 2000);
  }

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

  // Saves each person's Love total. The row holds the running total, so repeating is safe.
  async flushLove() {
    if (this.lovingNow || !this.st.itemId) return;
    const dirty = Object.entries(this.st.love).filter(([, v]) => v.dirty);
    if (!dirty.length) return;
    this.lovingNow = true;
    try {
      for (let i = 0; i < dirty.length; i += 500) {
        const part = dirty.slice(i, i + 500);
        const rows = part.map(([uid, v]) => ({ item_id: this.st.itemId, user_id: uid, taps: v.taps, updated_at: new Date().toISOString() }));
        const r = await this.sb('POST', 'live_love?on_conflict=item_id,user_id', rows, 'resolution=merge-duplicates,return=minimal');
        if (r && r.ok) { for (const [uid, v] of part) { const cur = this.st.love[uid]; if (cur && cur.taps === v.taps) cur.dirty = false; } }
        else { if (r) console.warn('Saving love failed', r.status); break; }
      }
      await this.save();
    } finally { this.lovingNow = false; }
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
      this.countMessage(att);
      await this.save();
      const out = { t: 'chat', msg: this.pub(msg) };
      this.each((w, a) => { if (!this.isBlocked(a)) this.send(w, out); });
      return;
    }

    if (m.t === 'love') {
      if (this.caps(att).react !== 'ok' || s.status !== 'live') return;
      const n = Math.min(LOVE_BATCH, Math.max(0, Math.floor(Number(m.n) || 0)));
      if (!n) return;
      const known = s.love[att.uid];
      if (!known && Object.keys(s.love).length >= MAX_LOVERS) return;
      const row = known || (s.love[att.uid] = { name: att.name, taps: 0, dirty: false });
      row.name = att.name; row.taps += n; row.dirty = true;
      this.saveSoon();
      const out = { t: 'love', name: att.name, uid8: att.uid.slice(0, 4), n, total: row.taps, all: this.loveTotal() };
      this.each((w, a) => { if (!this.isBlocked(a)) this.send(w, out); });
      return;
    }

    // A person shared the live (the share sheet finished or the link was copied). Only the host console hears about it.
    if (m.t === 'share') {
      if (att.owner || s.status !== 'live' || !this.shareAllow(att.uid)) return;
      const known = s.shared[att.uid];
      if (!known && Object.keys(s.shared).length >= MAX_SHARERS) return;
      const row = known || (s.shared[att.uid] = { n: att.name, c: 0, b: 0 });
      if (row.c >= MAX_SHARES_EACH) return;
      row.n = att.name; row.c += 1;
      this.saveSoon();
      this.toHost({ t: 'shared', name: att.name, uid8: att.uid.slice(0, 4), total: row.c, all: this.shareTotal() });
      return;
    }

    if (m.t === 'react') {
      if (this.caps(att).react !== 'ok') return;
      this.pulses[m.type === 'love' ? 'love' : 'like'] += 1;
      this.schedulePulses();
      return;
    }

    if (m.t === 'request') {
      const kind = 'request';
      const can = this.caps(att).request;
      if (can !== 'ok') return this.send(ws, { t: 'err', code: `request-${can}` });
      const text = clean(m.text, 200);
      if (!text) return;
      const open = s.requests.filter((r) => r.uid === att.uid && (r.status === 'queued' || r.status === 'reading')).length;
      if (!att.owner && open >= set.requestsPerViewer) return this.send(ws, { t: 'err', code: 'request-limit' });
      s.requests.push({ id: crypto.randomUUID(), uid: att.uid, name: att.name, kind, text, status: 'queued', at: Date.now() });
      if (s.requests.length > MAX_REQUESTS) s.requests.splice(0, s.requests.length - MAX_REQUESTS);
      await this.save();
      this.pushState();
      this.send(ws, { t: 'ok', what: 'request' });
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
      case 'poems': {
        const list = Array.isArray(m.titles) ? m.titles : [];
        const seen = new Set();
        const titles = [];
        for (const t of list) {
          const c = clean(t, POEM_CHARS);
          if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); titles.push(c); }
          if (titles.length >= MAX_POEMS) break;
        }
        s.poems = titles;
        await this.save();
        this.each((w, a) => { if (!this.isBlocked(a)) this.send(w, { t: 'poems', titles }); });
        return true;
      }
      case 'show': {
        s.show = { on: m.title === true, poem: clean(m.poem, 120), playing: clean(m.playing, 80) };
        await this.save();
        this.each((w, a) => { if (!this.isBlocked(a)) this.send(w, this.showFor(a)); });
        return true;
      }
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
    if (first) this.each((w, a) => { if (!a.owner && !this.isBlocked(a)) this.noteJoin(a); });
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
    await this.flushLove();
    const log = s.requests.map((r) => ({ name: r.name, kind: 'request', text: r.text, status: r.status, at: r.at }));
    await this.sb('PATCH', `live_sessions?item_id=eq.${s.itemId}`,
      { state: 'ended', ended_at: new Date(s.endedAt).toISOString(), peak_viewers: s.peak, requests: log }, 'return=minimal');
    await this.saveViewerLog();
  }

  // The viewer list for the recap: named people with when they joined, how many messages they wrote and how much
  // Love they gave. Guests only add to the counts. Needs migration 007; if it is not run yet nothing is lost, the
  // chat and Love are saved anyway and the recap says the viewer details are missing.
  async saveViewerLog() {
    const s = this.st;
    if (!s.itemId) return;
    const people = [];
    let anon = 0;
    let total = 0;
    const seen = new Set();
    for (const [uid, j] of Object.entries(s.joined)) {
      seen.add(uid);
      total++;
      const rec = j && typeof j === 'object' ? j : { n: '', a: s.startedAt, g: 0, m: 0 };
      if (rec.g) { anon++; continue; }
      people.push({ name: clean(rec.n || 'Viewer', 30), uid8: uid.slice(0, 4), joined_at: new Date(rec.a || s.startedAt || Date.now()).toISOString(), messages: rec.m || 0, love: s.love[uid]?.taps || 0 });
    }
    // Someone who sent Love but was never announced (the room restarted, say) still counts, if they have a name.
    for (const [uid, v] of Object.entries(s.love)) {
      if (seen.has(uid)) continue;
      total++;
      if (/^Guest [0-9a-f]{4}$/.test(v.name || '')) { anon++; continue; }
      people.push({ name: clean(v.name || 'Viewer', 30), uid8: uid.slice(0, 4), joined_at: null, messages: 0, love: v.taps || 0 });
    }
    people.sort((a, b) => String(a.joined_at || '~').localeCompare(String(b.joined_at || '~')));
    const row = { item_id: s.itemId, saved_at: new Date().toISOString(), viewers: people.slice(0, 2000), total_viewers: total, anon_viewers: anon, love_total: this.loveTotal() };
    const r = await this.sb('POST', 'live_log?on_conflict=item_id', [row], 'resolution=merge-duplicates,return=minimal');
    if (r && !r.ok) console.warn('Saving the viewer log failed', r.status);
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