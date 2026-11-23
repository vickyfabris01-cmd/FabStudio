// Audio through the Cloudflare SFU, from the browser. All calls go to the Worker (/live/sfu/*), which holds
// the secret and decides who may publish (the host) and who may listen (anyone the viewer mode allows).
//
//   publishAudio: the host's laptop sends ONE mixed audio track.
//   pullAudio:    a viewer receives it.
//
// If audio does not connect, the browser console shows which step failed; see docs/LIVE.md, "If something does not work".
import { CONFIG } from './config.js';

const ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// Every request gives up after 15 seconds. A request that never answers (a weak connection) used to freeze the
// whole reconnect; now it fails, and the caller can try again.
async function api(path, { method = 'POST', token, body }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let res;
  try {
    res = await fetch(CONFIG.API_BASE + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') { const t = new Error('The audio service did not answer in time. Check your connection.'); t.status = 0; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `api-${res.status}`);
    e.status = res.status;
    e.detail = data.detail || '';
    throw e;
  }
  return data;
}

// Opus settings go in the SDP before it is sent. Browsers ignore what they do not understand.
export function tuneOpus(sdp, { kbps = 96, stereo = true } = {}) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const want = { useinbandfec: 1, stereo: stereo ? 1 : 0, 'sprop-stereo': stereo ? 1 : 0, maxaveragebitrate: kbps * 1000, usedtx: 0 };
  const line = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (line.test(sdp)) {
    return sdp.replace(line, (_, old) => {
      const p = new Map(old.split(';').filter(Boolean).map((kv) => kv.split('=')));
      for (const [k, v] of Object.entries(want)) p.set(k, String(v));
      return `a=fmtp:${pt} ${[...p].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';')}`;
    });
  }
  const params = Object.entries(want).map(([k, v]) => `${k}=${v}`).join(';');
  return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000/2\\r?\\n)`), `$1a=fmtp:${pt} ${params}\r\n`);
}

function waitConnected(pc, ms = 15000) {
  return new Promise((resolve, reject) => {
    if (pc.connectionState === 'connected') return resolve();
    const timer = setTimeout(() => { cleanup(); reject(new Error('The audio connection timed out.')); }, ms);
    const on = () => {
      if (pc.connectionState === 'connected') { cleanup(); resolve(); }
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { cleanup(); reject(new Error('The audio connection failed.')); }
    };
    const cleanup = () => { clearTimeout(timer); pc.removeEventListener('connectionstatechange', on); };
    pc.addEventListener('connectionstatechange', on);
  });
}

// Host: send one audio track. Returns { sessionId, trackName, pc, close }.
export async function publishAudio({ item, getToken, track, kbps = 96, stereo = true }) {
  const { sessionId } = await api('/live/sfu/session', { token: await getToken(), body: { item } });
  const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
  try {
    const tr = pc.addTransceiver(track, { direction: 'sendonly' });
    const offer = await pc.createOffer();
    const sdp = tuneOpus(offer.sdp, { kbps, stereo });
    await pc.setLocalDescription({ type: 'offer', sdp });
    const trackName = 'audio';
    const out = await api('/live/sfu/tracks', {
      token: await getToken(),
      body: { item, sessionId, sessionDescription: { type: 'offer', sdp }, tracks: [{ location: 'local', mid: tr.mid, trackName }] },
    });
    if (!out.sessionDescription) throw new Error(out.errorDescription || 'The audio service gave no answer.');
    await pc.setRemoteDescription(out.sessionDescription);
    try {
      const p = tr.sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = kbps * 1000;
      await tr.sender.setParameters(p);
    } catch { /* the SDP setting above still applies */ }
    await waitConnected(pc);
    return { sessionId, trackName, pc, close: () => { try { pc.close(); } catch { /* closed */ } } };
  } catch (e) {
    try { pc.close(); } catch { /* closed */ }
    throw e;
  }
}

// Viewer: receive the live audio. onStream gets a MediaStream to put in an <audio> element.
export async function pullAudio({ item, getToken, onStream }) {
  const { sessionId } = await api('/live/sfu/session', { token: await getToken(), body: { item } });
  const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' });
  try {
    const stream = new MediaStream();
    pc.ontrack = (e) => { stream.addTrack(e.track); onStream(stream); };
    // The Worker decides which track this is; the browser only says "the live audio".
    const out = await api('/live/sfu/tracks', { token: await getToken(), body: { item, sessionId, tracks: [{ location: 'remote' }] } });
    if (!out.sessionDescription) throw new Error(out.errorDescription || 'The audio service gave no offer.');
    await pc.setRemoteDescription(out.sessionDescription);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await api('/live/sfu/renegotiate', { method: 'PUT', token: await getToken(), body: { item, sessionId, sessionDescription: { type: 'answer', sdp: answer.sdp } } });
    await waitConnected(pc);
    return { sessionId, pc, stream, close: () => { try { pc.close(); } catch { /* closed */ } } };
  } catch (e) {
    try { pc.close(); } catch { /* closed */ }
    throw e;
  }
}

// How the incoming audio is doing, every few seconds: { quality: 'good'|'fair'|'poor'|'stalled', loss, jitter, level }.
// A phone listening next to the laptop uses this to spot glitches.
export function watchQuality(pc, onQuality, ms = 3000) {
  let prev = null;
  const timer = setInterval(async () => {
    let inbound = null;
    try { (await pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') inbound = r; }); } catch { return; }
    if (!inbound) return;
    const lost = inbound.packetsLost || 0;
    const got = inbound.packetsReceived || 0;
    let quality = 'good';
    let loss = 0;
    if (prev) {
      const dl = lost - prev.lost;
      const dg = got - prev.got;
      loss = dl + dg > 0 ? dl / (dl + dg) : 0;
      if (dg <= 0) quality = 'stalled';
      else if (loss > 0.08) quality = 'poor';
      else if (loss > 0.02 || (inbound.jitter || 0) > 0.08) quality = 'fair';
    }
    prev = { lost, got };
    onQuality({ quality, loss, jitter: inbound.jitter || 0, level: typeof inbound.audioLevel === 'number' ? inbound.audioLevel : null });
  }, ms);
  return () => clearInterval(timer);
}
