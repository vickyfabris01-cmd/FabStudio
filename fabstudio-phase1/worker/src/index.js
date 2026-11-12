// FabStudio API: owner-only uploads to a PRIVATE R2 bucket.
// The browser sends the owner's Supabase access token; we verify it with Supabase,
// then check it belongs to OWNER_USER_ID. Nothing here is reachable by viewers.

const KEY_RE = /^(captures|tunes|bakes)\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
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

async function requireOwner(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Missing token');
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!r.ok) throw new HttpError(401, 'Invalid or expired token');
  const user = await r.json();
  if (!user || user.id !== env.OWNER_USER_ID) throw new HttpError(403, 'Not the owner');
}

function keyFrom(value) {
  if (!value || !KEY_RE.test(value)) throw new HttpError(400, 'Invalid key');
  return value;
}

export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/health') return json({ ok: true }, cors);

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

      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: e instanceof HttpError ? e.message : 'Server error' }, cors, status);
    }
  },
};
