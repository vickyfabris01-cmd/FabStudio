// Cloudflare Realtime SFU, called from the Worker so the app secret never reaches a browser.
// The SFU has no "rooms": it only knows sessions and tracks. The room (who is live, which track to
// pull, who may listen) is the LiveRoom Durable Object in live-room.js.
//
// API: https://developers.cloudflare.com/realtime/sfu/https-api/
//   POST /apps/{appId}/sessions/new                      -> { sessionId }
//   POST /apps/{appId}/sessions/{id}/tracks/new          -> { sessionDescription, tracks, requiresImmediateRenegotiation }
//   PUT  /apps/{appId}/sessions/{id}/renegotiate         -> { sessionDescription }

const DEFAULT_BASE = 'https://rtc.live.cloudflare.com/v1';

export const sfuConfigured = (env) => !!(env.SFU_APP_ID && env.SFU_APP_SECRET);

export async function sfuCall(env, path, method, body) {
  const base = (env.SFU_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const res = await fetch(`${base}/apps/${env.SFU_APP_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.SFU_APP_SECRET}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { errorDescription: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, data };
}

// Session ids come back from Cloudflare; check the shape before putting one in a URL.
export const SESSION_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const TRACK_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const createSession = (env) => sfuCall(env, '/sessions/new', 'POST');
export const newTracks = (env, sessionId, body) => sfuCall(env, `/sessions/${sessionId}/tracks/new`, 'POST', body);
export const renegotiate = (env, sessionId, body) => sfuCall(env, `/sessions/${sessionId}/renegotiate`, 'PUT', body);
