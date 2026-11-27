// AAC encoding in the browser (WebCodecs), used to turn a live recording (WebM/Opus, which many iPhones cannot
// play) into an .m4a, and for the sound of a video file. Runs on the computer, nothing is uploaded.
import { Mp4Writer } from './mp4-mux.js';

export const SR = 48000;
const tick = () => new Promise((r) => setTimeout(r, 0));

export const canEncodeAac = async (channels = 2) => {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
  try { return !!(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: channels, bitrate: 128000, aac: { format: 'aac' } })).supported; } catch { return false; }
};

// AudioSpecificConfig for AAC-LC when the encoder does not hand one over.
export function ascFor(sampleRate, channels) {
  const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sampleRate);
  return Uint8Array.from([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
}

// Decodes a recording to raw sound at 48 kHz.
export async function decodeAudio(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
  try { return await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close?.(); }
}

// Encodes a decoded AudioBuffer to AAC. Returns { frames: Uint8Array[], asc, channels }.
// onProgress(0..1) is called now and then; signal can cancel.
export async function encodeAac(buf, { channels = Math.min(2, buf.numberOfChannels), onProgress = () => {}, signal = null } = {}) {
  const frames = [];
  let asc = null;
  let failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      if (meta?.decoderConfig?.description && !asc) asc = new Uint8Array(meta.decoderConfig.description);
      frames.push(d);
    },
    error: (e) => { failure = e; },
  });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: channels, bitrate: 128000, aac: { format: 'aac' } });
  try {
    const piece = 4096;
    const planes = [];
    for (let c = 0; c < channels; c++) planes.push(buf.getChannelData(c));
    for (let pos = 0; pos < buf.length; pos += piece) {
      if (signal?.aborted) throw new Error('Cancelled.');
      if (failure) throw failure;
      const n = Math.min(piece, buf.length - pos);
      const data = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) data.set(planes[c].subarray(pos, pos + n), c * n);      // planar: channel 0, then channel 1
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((pos / SR) * 1e6), data });
      enc.encode(ad);
      ad.close();
      while (enc.encodeQueueSize > 8) await tick();
      if ((pos / piece) % 40 === 0) { onProgress(pos / buf.length); await tick(); }
    }
    await enc.flush();
    if (failure) throw failure;
  } finally {
    try { enc.close(); } catch { /* already closed */ }
  }
  return { frames, asc: asc || ascFor(SR, channels), channels };
}

// Any recording -> an .m4a that plays everywhere. Returns { blob, mime: 'audio/mp4', duration } or null when this
// browser cannot encode AAC (the caller keeps the original file then).
export async function toM4a(blob, opts = {}) {
  if (!(await canEncodeAac(2))) return null;
  const buf = await decodeAudio(blob);
  const { frames, asc, channels } = await encodeAac(buf, opts);
  if (!frames.length) return null;
  const w = new Mp4Writer({ audio: { channels, sampleRate: SR, asc }, brand: 'M4A ' });
  frames.forEach((f) => w.addAudio(f, 1024));
  return { blob: w.finish(), mime: 'audio/mp4', duration: buf.duration };
}
