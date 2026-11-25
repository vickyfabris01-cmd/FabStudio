// YouTube for FabStudio. Owner only, read only, and nothing here touches the audio live.
//
//   GET  /youtube/callback      Google sends the browser back here after you allow access (checked by a signed state)
//   GET  /youtube/status        is it set up, is it connected
//   POST /youtube/connect       gives the Google sign-in address
//   POST /youtube/disconnect    forgets the connection and tells Google to revoke it
//   GET  /youtube/live          ONE request to YouTube: is your channel live right now (the "Check YouTube live" button)
//   GET  /youtube/videos        a page of your uploads (about 2 quota units per page)
//   POST /youtube/publish       puts one of your videos on Fabris Poet as a post that plays from YouTube
//
// The refresh token lives in the Supabase table youtube_link, which only this Worker (service key) can read.
// Secrets: YT_CLIENT_ID, YT_CLIENT_SECRET (docs/YOUTUBE-UPDATE.md). Nothing is ever polled: YouTube is only
// asked when a button is pressed.

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const API = 'https://www.googleapis.com/youtube/v3';
const VIDEO_RE = /^[A-Za-z0-9_-]{11}$/;
const enc = new TextEncoder();

class YtError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, cors, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export const youtubeConfigured = (env) => !!(env.YT_CLIENT_ID && env.YT_CLIENT_SECRET && env.SUPABASE_SERVICE_KEY);

/* ---------- Supabase (service key): the saved connection and the posts ---------- */
const svc = (env) => ({ apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` });

async function dbGet(env, path) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: svc(env) });
  if (!r.ok) throw new YtError(502, 'The database refused this. Did you run migration 012_youtube.sql?');
  return await r.json();
}
async function dbSend(env, path, method, body, prefer = 'return=minimal') {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method, headers: { ...svc(env), 'Content-Type': 'application/json', Prefer: prefer }, body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new YtError(502, 'The database refused this. Did you run migration 012_youtube.sql?');
}
const getLink = async (env) => (await dbGet(env, 'youtube_link?id=eq.1&select=*'))[0] || null;
const saveLink = (env, row) => dbSend(env, 'youtube_link?on_conflict=id', 'POST', { id: 1, ...row }, 'resolution=merge-duplicates,return=minimal');
const deleteLink = (env) => dbSend(env, 'youtube_link?id=eq.1', 'DELETE');

/* ---------- signed state for the Google round trip (no extra secret: the Google client secret signs it) ---------- */
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function mac(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.YT_CLIENT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
async function signState(env, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${await mac(env, body)}`;
}
async function readState(env, state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig || !same(await mac(env, body), sig)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return p && p.exp > Date.now() && typeof p.r === 'string' ? p : null;
  } catch { return null; }
}

/* ---------- Google ---------- */
const redirectUri = (url) => `${url.origin}/youtube/callback`;
let cached = { token: '', exp: 0 };

async function tokenCall(env, params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, ...params }),
  });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const link = await getLink(env);
  if (!link) throw new YtError(409, 'YouTube is not connected.');
  const { ok, data } = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: link.refresh_token });
  if (!ok) {
    if (data.error === 'invalid_grant') {
      await deleteLink(env).catch(() => {});
      cached = { token: '', exp: 0 };
      throw new YtError(409, 'The YouTube connection has expired. Connect again.');
    }
    throw new YtError(502, 'Google refused the sign-in. Try connecting again.');
  }
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cached.token;
}

async function gapi(env, path, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(env);
    const r = await fetch(`${API}/${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401 && attempt === 0) { cached = { token: '', exp: 0 }; continue; }
    const d = await r.json().catch(() => ({}));
    if (r.ok) return d;
    const reason = d?.error?.errors?.[0]?.reason || '';
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') throw new YtError(429, 'YouTube\'s daily allowance for this app is used up. Try again after midnight Pacific time.');
    if (reason === 'liveStreamingNotEnabled') throw new YtError(409, 'Live streaming is not enabled on this YouTube channel yet.');
    throw new YtError(502, `YouTube said no (${reason || r.status}).`);
  }
  throw new YtError(502, 'YouTube said no.');
}

const seconds = (iso) => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
};
const bestThumb = (t) => (t?.medium || t?.high || t?.default || t?.standard || {}).url || '';

/* ---------- the Google round trip ---------- */
export async function youtubeCallback(request, env, url) {
  if (!youtubeConfigured(env)) return new Response('YouTube is not set up on this Worker.', { status: 501 });
  const st = await readState(env, url.searchParams.get('state'));
  if (!st) return new Response('This sign-in link has expired. Go back to FabStudio and press Connect YouTube again.', { status: 400 });
  const go = (flag) => { const u = new URL(st.r); u.searchParams.set('yt', flag); return Response.redirect(u.toString(), 302); };
  if (url.searchParams.get('error')) return go('denied');
  const code = url.searchParams.get('code');
  if (!code) return go('error');
  const { ok, data } = await tokenCall(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(url) });
  if (!ok || !data.refresh_token || !data.access_token) return go('error');
  const r = await fetch(`${API}/channels?${new URLSearchParams({ part: 'snippet,contentDetails', mine: 'true' })}`, { headers: { Authorization: `Bearer ${data.access_token}` } });
  const ch = r.ok ? (await r.json().catch(() => ({}))).items?.[0] : null;
  if (!ch) { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(data.refresh_token)}`, { method: 'POST' }).catch(() => {}); return go('nochannel'); }
  await saveLink(env, {
    refresh_token: data.refresh_token, channel_id: ch.id, channel_title: String(ch.snippet?.title || '').slice(0, 100),
    uploads_playlist: ch.contentDetails?.relatedPlaylists?.uploads || null, connected_at: new Date().toISOString(),
  });
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return go('connected');
}

/* ---------- the owner's routes (the caller has already been checked as the owner) ---------- */
export async function youtubeOwner(request, env, cors, url) {
  const path = url.pathname;
  const method = request.method;
  try {
    if (path === '/youtube/status' && method === 'GET') {
      if (!youtubeConfigured(env)) return json({ configured: false, connected: false }, cors);
      const link = await getLink(env);
      return json({ configured: true, connected: !!link, channelTitle: link?.channel_title || '' }, cors);
    }

    if (!youtubeConfigured(env)) throw new YtError(501, 'YouTube is not set up on the Worker yet (see docs/YOUTUBE-UPDATE.md).');

    if (path === '/youtube/connect' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      let back = '';
      try { const u = new URL(String(body.return || '')); if (allowed.includes(u.origin)) back = u.origin + u.pathname; } catch { /* use the default */ }
      if (!back) back = `${allowed[0] || url.origin}/studio/`;
      const state = await signState(env, { r: back, exp: Date.now() + 10 * 60 * 1000 });
      const auth = new URLSearchParams({
        client_id: env.YT_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      });
      return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${auth}` }, cors);
    }

    if (path === '/youtube/disconnect' && method === 'POST') {
      const link = await getLink(env);
      if (link) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(link.refresh_token)}`, { method: 'POST' }).catch(() => {});
        await deleteLink(env);
      }
      cached = { token: '', exp: 0 };
      return json({ ok: true }, cors);
    }

    // The "Check YouTube live" button. One request to YouTube (about 1 quota unit), only when pressed.
    if (path === '/youtube/live' && method === 'GET') {
      if (!(await getLink(env))) return json({ connected: false, live: null }, cors);
      const d = await gapi(env, 'liveBroadcasts', { part: 'snippet,status,contentDetails', broadcastStatus: 'active', maxResults: '5' });
      const items = (d.items || []).filter((b) => b.status?.lifeCycleStatus !== 'testing');
      items.sort((a, b) => String(b.snippet?.actualStartTime || '').localeCompare(String(a.snippet?.actualStartTime || '')));
      const b = items[0];
      if (!b) return json({ connected: true, live: null }, cors);
      const privacy = b.status?.privacyStatus || '';
      return json({
        connected: true,
        live: {
          videoId: b.id, title: String(b.snippet?.title || '').slice(0, 120), thumb: bestThumb(b.snippet?.thumbnails),
          privacy, embeddable: b.contentDetails?.enableEmbed !== false && privacy !== 'private',
        },
      }, cors);
    }

    if (path === '/youtube/videos' && method === 'GET') {
      const link = await getLink(env);
      if (!link) return json({ connected: false, items: [], next: null }, cors);
      let uploads = link.uploads_playlist;
      if (!uploads) {
        const c = await gapi(env, 'channels', { part: 'contentDetails', mine: 'true' });
        uploads = c.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploads) throw new YtError(409, 'This channel has no uploads yet.');
        await saveLink(env, { refresh_token: link.refresh_token, channel_id: link.channel_id, channel_title: link.channel_title, uploads_playlist: uploads, connected_at: link.connected_at });
      }
      const page = String(url.searchParams.get('page') || '').slice(0, 100);
      const list = await gapi(env, 'playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '20', ...(page ? { pageToken: page } : {}) });
      const ids = (list.items || []).map((i) => i.contentDetails?.videoId).filter((x) => VIDEO_RE.test(String(x || '')));
      let videos = [];
      if (ids.length) videos = (await gapi(env, 'videos', { part: 'snippet,contentDetails,status', id: ids.join(',') })).items || [];
      const byId = new Map(videos.map((v) => [v.id, v]));
      let onSite = new Map();
      if (ids.length) {
        try { onSite = new Map((await dbGet(env, `published_items?youtube_id=in.(${ids.join(',')})&select=id,youtube_id`)).map((r) => [r.youtube_id, r.id])); } catch { /* before migration 012 nothing is on the site */ }
      }
      const items = ids.filter((id) => byId.has(id)).map((id) => {
        const v = byId.get(id);
        return {
          id, title: String(v.snippet?.title || '').slice(0, 200), thumb: bestThumb(v.snippet?.thumbnails), seconds: seconds(v.contentDetails?.duration),
          privacy: v.status?.privacyStatus || '', embeddable: v.status?.embeddable !== false, live: v.snippet?.liveBroadcastContent || 'none',
          publishedAt: v.snippet?.publishedAt || '', itemId: onSite.get(id) || null,
        };
      });
      return json({ connected: true, channelTitle: link.channel_title || '', items, next: list.nextPageToken || null }, cors);
    }

    if (path === '/youtube/publish' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const videoId = String(body.videoId || '');
      if (!VIDEO_RE.test(videoId)) throw new YtError(400, 'That is not a YouTube video.');
      const link = await getLink(env);
      if (!link) throw new YtError(409, 'YouTube is not connected.');
      const had = (await dbGet(env, `published_items?youtube_id=eq.${videoId}&select=id`))[0];
      if (had) return json({ id: had.id, already: true }, cors);
      const v = (await gapi(env, 'videos', { part: 'snippet,contentDetails,status', id: videoId })).items?.[0];
      if (!v) throw new YtError(404, 'That video was not found.');
      if (link.channel_id && v.snippet?.channelId !== link.channel_id) throw new YtError(400, 'Only videos from your own channel can be added.');
      if (v.status?.privacyStatus === 'private') throw new YtError(400, 'This video is Private on YouTube. Make it Unlisted or Public first.');
      if (v.status?.embeddable === false) throw new YtError(400, 'Embedding is switched off for this video. Turn on "Allow embedding" in YouTube Studio.');
      if (v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none') throw new YtError(400, 'This is a live that has not finished. Add it after it ends, or use Check YouTube live on a live page.');

      const id = crypto.randomUUID();
      // The picture is copied to your own public bucket, so cards and share previews work like any other post.
      let thumbKey = null;
      for (const name of ['maxresdefault', 'hqdefault']) {
        try {
          const t = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}.jpg`);
          if (!t.ok) continue;
          const buf = await t.arrayBuffer();
          if (buf.byteLength < 3000) continue;
          thumbKey = `pub/${id}/thumb-${Date.now()}.jpg`;
          await env.PUBLIC_BUCKET.put(thumbKey, buf, { httpMetadata: { contentType: 'image/jpeg' } });
          break;
        } catch { thumbKey = null; }
      }
      const now = new Date().toISOString();
      try {
        await dbSend(env, 'published_items', 'POST', {
          id, kind: 'video', title: String(v.snippet?.title || 'Untitled').slice(0, 200), description: '', mime: null,
          duration: seconds(v.contentDetails?.duration) || null, public_thumb_key: thumbKey, status: 'published', published_at: now,
          comments_enabled: true, reactions_enabled: true, created_at: now, updated_at: now, youtube_id: videoId,
        });
      } catch (e) {
        if (thumbKey) await env.PUBLIC_BUCKET.delete(thumbKey).catch(() => {});
        throw e;
      }
      return json({ id, title: v.snippet?.title || '' }, cors);
    }
    throw new YtError(404, 'Not found');
  } catch (e) {
    if (e instanceof YtError) return json({ error: e.message }, cors, e.status);
    return json({ error: 'Server error' }, cors, 500);
  }
}
