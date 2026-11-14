// FabStudio API (Cloudflare Worker).
//  - Owner-only: uploads to the PRIVATE bucket, publish / unpublish / delete.
//  - Public: streams published files from the PUBLIC bucket (GET /public/...).
//  - Viewers: merges a guest's reactions and comments into their real account.

const KEY_RE = /^(captures|tunes|bakes|items|thumbs)\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
const PUB_RE = /^pub\/[0-9a-f-]{36}\/(media|thumb)\.[a-z0-9]{2,5}$/;
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
        await deleteByPrefix(env.PUBLIC_BUCKET, `pub/${id}/`);
        for (const [from, to] of [[mediaKey, publicMediaKey], [thumbKey, publicThumbKey]]) {
          const obj = await bucket.get(from);
          if (!obj) throw new HttpError(404, 'File not uploaded yet');
          await env.PUBLIC_BUCKET.put(to, obj.body, { httpMetadata: obj.httpMetadata });
        }
        return json({ publicMediaKey, publicThumbKey }, cors);
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

      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: e instanceof HttpError ? e.message : 'Server error' }, cors, status);
    }
  },
};
