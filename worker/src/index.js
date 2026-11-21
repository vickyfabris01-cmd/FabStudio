// FabStudio API (Cloudflare Worker).
//  - Owner-only: uploads to the PRIVATE bucket, publish / unpublish / delete.
//  - Public: streams published files from the PUBLIC bucket (GET /public/...).
//  - Viewers: merges a guest's reactions and comments into their real account.
//  - Live (Phase 3): /live/ws (the room), /live/sfu/* (audio through the Cloudflare SFU), /live/assets (replay files).

import { LiveRoom } from './live-room.js';
import { sfuConfigured, createSession, newTracks, renegotiate, SESSION_RE, TRACK_RE } from './sfu.js';

export { LiveRoom };

// <folder>/<id>.<ext>, plus an item's second version (items/<id>.alt.<ext>) and screen background (thumbs/<id>.bg.<ext>)
const KEY_RE = /^(captures|tunes|bakes|items|thumbs)\/[0-9a-f-]{36}(\.(alt|bg))?\.[a-z0-9]{2,5}$/;
const PUB_RE = /^(pub\/[0-9a-f-]{36}\/(media|thumb|alt|bg)\.[a-z0-9]{2,5}|hero\/[1-7]-[0-9]{10,14}\.jpg)$/;   // posts, and the home page hero pictures
const UUID_RE = /^[0-9a-f-]{36}$/;
const MAX_PART = 10 * 1024 * 1024; // client sends 8 MB parts; allow headroom

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { Vary: 'Origin' };
  if (allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const json = (data, cors, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });

async function getUser(token, env) {
  if (!token) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  return r.ok ? await r.json() : null;
}
const bearer = (request) => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');

async function requireOwner(request, env) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, 'Missing token');
  const user = await getUser(token, env);
  if (!user) throw new HttpError(401, 'Invalid or expired token');
  if (user.id !== env.OWNER_USER_ID) throw new HttpError(403, 'Not the owner');
}

function keyFrom(value) {
  if (!value || !KEY_RE.test(value)) throw new HttpError(400, 'Invalid key');
  return value;
}
function idFrom(value) {
  if (!value || !UUID_RE.test(value)) throw new HttpError(400, 'Invalid id');
  return value;
}
const extOf = (key) => key.slice(key.lastIndexOf('.') + 1);

/* ---------- Live ---------- */
const SDP_MAX = 60000;
const sdpFrom = (d, type) => {
  if (!d || d.type !== type || typeof d.sdp !== 'string' || d.sdp.length > SDP_MAX) throw new HttpError(400, `Expected a ${type}`);
  return { type, sdp: d.sdp };
};
const sfuFail = (r, cors) => json({ error: 'The audio service refused this', detail: String(r.data?.errorDescription || r.data?.errorCode || r.status).slice(0, 200) }, cors, 502);

// Routes that do not need the owner. Each one checks who is calling.
async function liveRoute(request, env, cors, url) {
  const path = url.pathname;
  if (!env.LIVE_ROOM) throw new HttpError(501, 'Live is not set up on this Worker yet (see docs/LIVE.md, section 3)');
  const room = (item) => {
    const stub = env.LIVE_ROOM.get(env.LIVE_ROOM.idFromName(item));
    return (p, init = {}) => {
      const req = new Request(`https://room${p}`, init.request || { headers: init.headers });
      req.headers.set('x-item-id', item);
      return stub.fetch(req);
    };
  };

  // The room: browsers connect here. They sign in with the first message (hello), not with a header.
  if (path === '/live/ws') {
    if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
    if (!cors['Access-Control-Allow-Origin']) throw new HttpError(403, 'This address is not in ALLOWED_ORIGINS');
    const item = idFrom(url.searchParams.get('item'));
    return await room(item)('/ws', { request });
  }

  // Audio. The SFU secret stays here; the browser only ever talks to these routes.
  if (path.startsWith('/live/sfu/')) {
    if (!sfuConfigured(env)) throw new HttpError(501, 'The audio service is not set up yet (SFU_APP_ID and SFU_APP_SECRET)');
    const user = await getUser(bearer(request), env);
    if (!user) throw new HttpError(401, 'Sign in first');
    const isOwner = user.id === env.OWNER_USER_ID;
    const body = await request.json().catch(() => ({}));
    const item = idFrom(body.item);
    const info = await (await room(item)('/info')).json();

    // Listening needs a live room, and the viewer mode is enforced here too (not just in the page).
    const mayListen = () => {
      if (info.status !== 'live') throw new HttpError(409, 'This live is not on right now');
      if (!info.broadcaster?.online) throw new HttpError(409, 'The audio is reconnecting');
      if (info.mode === 'login' && user.is_anonymous && !isOwner) throw new HttpError(403, 'Sign in to listen to this live');
    };

    if (path === '/live/sfu/session' && request.method === 'POST') {
      if (isOwner) { if (info.status === 'ended') throw new HttpError(409, 'This live has ended'); }
      else mayListen();
      const r = await createSession(env);
      if (!r.ok || !r.data.sessionId) return sfuFail(r, cors);
      return json({ sessionId: r.data.sessionId }, cors);
    }

    if (path === '/live/sfu/tracks' && request.method === 'POST') {
      const sessionId = String(body.sessionId || '');
      if (!SESSION_RE.test(sessionId)) throw new HttpError(400, 'Bad session');
      const t = Array.isArray(body.tracks) && body.tracks.length === 1 ? body.tracks[0] : null;
      if (!t) throw new HttpError(400, 'One track at a time');
      let payload;
      if (t.location === 'local') {
        // Publishing: the owner only, and one audio track.
        if (!isOwner) throw new HttpError(403, 'Only the host can broadcast');
        if (info.status === 'ended') throw new HttpError(409, 'This live has ended');
        if (!TRACK_RE.test(String(t.trackName || '')) || typeof t.mid !== 'string' || t.mid.length > 16) throw new HttpError(400, 'Bad track');
        payload = { sessionDescription: sdpFrom(body.sessionDescription, 'offer'), tracks: [{ location: 'local', mid: t.mid, trackName: t.trackName }] };
      } else if (t.location === 'remote') {
        // Listening: always the room's current audio track, whatever the browser asked for.
        mayListen();
        payload = { tracks: [{ location: 'remote', sessionId: info.broadcaster.sessionId, trackName: info.broadcaster.trackName }] };
      } else throw new HttpError(400, 'Bad track');
      const r = await newTracks(env, sessionId, payload);
      if (!r.ok || r.data.errorCode) return sfuFail(r, cors);
      return json(r.data, cors);
    }

    if (path === '/live/sfu/renegotiate' && request.method === 'PUT') {
      const sessionId = String(body.sessionId || '');
      if (!SESSION_RE.test(sessionId)) throw new HttpError(400, 'Bad session');
      const r = await renegotiate(env, sessionId, { sessionDescription: sdpFrom(body.sessionDescription, 'answer') });
      if (!r.ok || r.data.errorCode) return sfuFail(r, cors);
      return json(r.data, cors);
    }
  }
  throw new HttpError(404, 'Not found');
}

async function deleteByPrefix(bucket, prefix) {
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// Public file download with Range support (needed for audio/video seeking).
async function servePublic(request, env, key) {
  if (!PUB_RE.test(key)) throw new HttpError(404, 'Not found');
  const wantsRange = request.headers.has('Range');
  const obj = await env.PUBLIC_BUCKET.get(key, wantsRange ? { range: request.headers } : undefined);
  if (!obj) throw new HttpError(404, 'Not found');
  const h = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  });
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  // ?download=<file name> makes the browser save the file under that name instead of playing it.
  const dl = new URL(request.url).searchParams.get('download');
  if (dl) {
    const name = dl.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
    if (name) {
      const ascii = name.replace(/[^\x20-\x7e]/g, '_');
      const star = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      h.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${star}`);
    }
  }
  let status = 200;
  if (wantsRange && obj.range) {
    let start;
    let end;
    if ('suffix' in obj.range) { start = obj.size - obj.range.suffix; end = obj.size - 1; }
    else { start = obj.range.offset ?? 0; end = start + (obj.range.length ?? obj.size - start) - 1; }
    h.set('Content-Range', `bytes ${start}-${end}/${obj.size}`);
    h.set('Content-Length', String(end - start + 1));
    status = 206;
  } else {
    h.set('Content-Length', String(obj.size));
  }
  return new Response(request.method === 'HEAD' ? null : obj.body, { status, headers: h });
}

async function mergeViewer(request, env, cors) {
  if (!env.SUPABASE_SERVICE_KEY) throw new HttpError(501, 'Merge is not configured');
  const account = await getUser(bearer(request), env);
  const body = await request.json().catch(() => ({}));
  const guest = await getUser(body.guestToken, env);
  if (!account || !guest) throw new HttpError(401, 'Invalid token');
  if (account.is_anonymous) throw new HttpError(400, 'Sign in first');
  if (!guest.is_anonymous) throw new HttpError(400, 'Not a guest');
  if (account.id === guest.id) throw new HttpError(400, 'Same user');
  const svc = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/merge_users`, {
    method: 'POST',
    headers: { ...svc, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_guest: guest.id, p_account: account.id }),
  });
  if (!r.ok) throw new HttpError(502, 'Merge failed');
  // The empty guest account is no longer needed. Failure here is harmless.
  await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${guest.id}`, { method: 'DELETE', headers: svc }).catch(() => {});
  return json({ ok: true }, cors);
}

export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/health') return json({ ok: true }, cors);

      // ---- public (no sign-in)
      if (path.startsWith('/public/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return await servePublic(request, env, decodeURIComponent(path.slice('/public/'.length)));
      }
      if (path === '/viewer/merge' && request.method === 'POST') return await mergeViewer(request, env, cors);

      // ---- live (each route checks who is calling; /live/assets below is owner only)
      if (path.startsWith('/live/') && path !== '/live/assets') return await liveRoute(request, env, cors, url);

      // ---- owner only
      await requireOwner(request, env);
      const bucket = env.PRIVATE_BUCKET;
      const maxBytes = Number(env.MAX_UPLOAD_MB || 200) * 1024 * 1024;

      if (path === '/upload/start' && request.method === 'POST') {
        const b = await request.json();
        const key = keyFrom(b.key);
        if (!(b.size > 0) || b.size > maxBytes) throw new HttpError(413, 'File too large');
        const mp = await bucket.createMultipartUpload(key, {
          httpMetadata: { contentType: String(b.contentType || 'application/octet-stream') },
        });
        return json({ uploadId: mp.uploadId }, cors);
      }

      if (path === '/upload/part' && request.method === 'PUT') {
        const key = keyFrom(url.searchParams.get('key'));
        const uploadId = url.searchParams.get('uploadId');
        const n = Number(url.searchParams.get('partNumber'));
        if (!uploadId || !Number.isInteger(n) || n < 1 || n > 10000) throw new HttpError(400, 'Bad part');
        const buf = await request.arrayBuffer();
        if (buf.byteLength === 0 || buf.byteLength > MAX_PART) throw new HttpError(413, 'Bad part size');
        const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(n, buf);
        return json({ partNumber: n, etag: part.etag }, cors);
      }

      if (path === '/upload/complete' && request.method === 'POST') {
        const b = await request.json();
        const key = keyFrom(b.key);
        if (!b.uploadId || !Array.isArray(b.parts) || !b.parts.length) throw new HttpError(400, 'Bad request');
        await bucket.resumeMultipartUpload(key, b.uploadId).complete(
          b.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
        );
        return json({ ok: true }, cors);
      }

      if (path === '/upload/abort' && request.method === 'POST') {
        const b = await request.json();
        await bucket.resumeMultipartUpload(keyFrom(b.key), b.uploadId).abort();
        return json({ ok: true }, cors);
      }

      if (path === '/upload/object' && request.method === 'PUT') {
        const key = keyFrom(url.searchParams.get('key'));
        const buf = await request.arrayBuffer();
        if (buf.byteLength === 0 || buf.byteLength > MAX_PART) throw new HttpError(413, 'Bad size');
        await bucket.put(key, buf, {
          httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
        });
        return json({ ok: true }, cors);
      }

      if (path === '/upload/object' && request.method === 'DELETE') {
        await bucket.delete(keyFrom(url.searchParams.get('key')));
        return json({ ok: true }, cors);
      }

      if (path === '/media' && request.method === 'GET') {
        const obj = await bucket.get(keyFrom(url.searchParams.get('key')));
        if (!obj) throw new HttpError(404, 'Not found');
        const h = new Headers(cors);
        obj.writeHttpMetadata(h);
        h.set('etag', obj.httpEtag);
        h.set('Cache-Control', 'private, no-store');
        return new Response(obj.body, { headers: h });
      }

      // Copy an item's files from the private bucket to the public one.
      if (path === '/publish' && request.method === 'POST') {
        const b = await request.json();
        const id = idFrom(b.itemId);
        const mediaKey = keyFrom(b.mediaKey);
        const thumbKey = keyFrom(b.thumbKey);
        if (!mediaKey.startsWith(`items/${id}.`) || !thumbKey.startsWith(`thumbs/${id}.`)) throw new HttpError(400, 'Keys do not match item');
        const publicMediaKey = `pub/${id}/media.${extOf(mediaKey)}`;
        const publicThumbKey = `pub/${id}/thumb.${extOf(thumbKey)}`;
        const pairs = [[mediaKey, publicMediaKey], [thumbKey, publicThumbKey]];
        const out = { publicMediaKey, publicThumbKey };
        // The second version (an audio item's video, a video item's audio) and the animated screen's background picture.
        if (b.altKey) {
          const altKey = keyFrom(b.altKey);
          if (!altKey.startsWith(`items/${id}.`)) throw new HttpError(400, 'Keys do not match item');
          out.publicAltKey = `pub/${id}/alt.${extOf(altKey)}`;
          pairs.push([altKey, out.publicAltKey]);
        }
        if (b.bgKey) {
          const bgKey = keyFrom(b.bgKey);
          if (!bgKey.startsWith(`thumbs/${id}.`)) throw new HttpError(400, 'Keys do not match item');
          out.publicBgKey = `pub/${id}/bg.${extOf(bgKey)}`;
          pairs.push([bgKey, out.publicBgKey]);
        }
        await deleteByPrefix(env.PUBLIC_BUCKET, `pub/${id}/`);
        for (const [from, to] of pairs) {
          const obj = await bucket.get(from);
          if (!obj) throw new HttpError(404, 'File not uploaded yet');
          await env.PUBLIC_BUCKET.put(to, obj.body, { httpMetadata: obj.httpMetadata });
        }
        return json(out, cors);
      }

      // Live: copies a live item's thumbnail and, once the show is over, its recording to the public bucket.
      // The recording is the capture FabStudio saved on the laptop (captures/<id>.<ext>).
      if (path === '/live/assets' && request.method === 'POST') {
        const b = await request.json();
        const id = idFrom(b.itemId);
        const out = {};
        if (b.thumbKey) {
          const from = keyFrom(b.thumbKey);
          if (!from.startsWith(`thumbs/${id}.`)) throw new HttpError(400, 'Thumbnail does not match item');
          out.publicThumbKey = `pub/${id}/thumb.${extOf(from)}`;
          const obj = await bucket.get(from);
          if (!obj) throw new HttpError(404, 'Thumbnail not uploaded yet');
          await deleteByPrefix(env.PUBLIC_BUCKET, `pub/${id}/thumb.`);
          await env.PUBLIC_BUCKET.put(out.publicThumbKey, obj.body, { httpMetadata: obj.httpMetadata });
        }
        if (b.recordingKey) {
          const from = keyFrom(b.recordingKey);
          if (!from.startsWith('captures/')) throw new HttpError(400, 'That is not a recording');
          out.publicMediaKey = `pub/${id}/media.${extOf(from)}`;
          const obj = await bucket.get(from);
          if (!obj) throw new HttpError(404, 'Recording not uploaded yet');
          await deleteByPrefix(env.PUBLIC_BUCKET, `pub/${id}/media.`);
          await env.PUBLIC_BUCKET.put(out.publicMediaKey, obj.body, { httpMetadata: obj.httpMetadata });
        }
        if (!out.publicThumbKey && !out.publicMediaKey) throw new HttpError(400, 'Nothing to copy');
        return json(out, cors);
      }

      if (path === '/unpublish' && request.method === 'POST') {
        const id = idFrom((await request.json()).itemId);
        await deleteByPrefix(env.PUBLIC_BUCKET, `pub/${id}/`);
        return json({ ok: true }, cors);
      }

      // Removes every file of an item, public and private.
      if (path === '/item/delete' && request.method === 'POST') {
        const id = idFrom((await request.json()).itemId);
        await deleteByPrefix(env.PUBLIC_BUCKET, `pub/${id}/`);
        await deleteByPrefix(bucket, `items/${id}.`);
        await deleteByPrefix(bucket, `thumbs/${id}.`);
        return json({ ok: true }, cors);
      }

      // The home page hero pictures (7 slots). Each replacement gets a new file name so no cache shows the old one.
      if (path === '/hero/put' && request.method === 'PUT') {
        const slot = Number(url.searchParams.get('slot'));
        if (!Number.isInteger(slot) || slot < 1 || slot > 7) throw new HttpError(400, 'Bad slot');
        const buf = await request.arrayBuffer();
        if (buf.byteLength === 0 || buf.byteLength > 3 * 1024 * 1024) throw new HttpError(413, 'Picture too big (3 MB at most)');
        const key = `hero/${slot}-${Date.now()}.jpg`;
        await env.PUBLIC_BUCKET.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
        const page = await env.PUBLIC_BUCKET.list({ prefix: `hero/${slot}-` });
        const old = page.objects.map((o) => o.key).filter((k) => k !== key);
        if (old.length) await env.PUBLIC_BUCKET.delete(old);
        return json({ ok: true, key }, cors);
      }

      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: e instanceof HttpError ? e.message : 'Server error' }, cors, status);
    }
  },
};
