// Makes the video version of an audio item, in the browser, on the laptop. Nothing is uploaded for this.
//   audio file + picture + lyrics  ->  the animated scene, drawn frame by frame  ->  H.264 video + AAC audio  ->  .mp4
// It uses the browser's own encoders (WebCodecs), so it runs faster than real time on a computer, and the file is a
// normal MP4 that phones, WhatsApp and every player understand. Frames are drawn by the same function the public
// player uses (shared/scene.js), so the video looks exactly like the player.
import { drawScene, barsFromSamples, SCENE_W, SCENE_H } from '../../shared/scene.js';
import { Mp4Writer } from './mp4-mux.js';
import { SR, ascFor, canEncodeAac, decodeAudio, encodeAac } from './audio-encode.js';

export const MAX_SECONDS = 600;
const FPS = 24;

export const canRender = () => typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function logo() {
  try { return await createImageBitmap(await (await fetch('/studio/icons/mark.png')).blob()); } catch { return null; }
}

// opts: { audio: Blob, title, bg: Blob|null, lyrics: [{s,e,t}]|null, anim, onProgress(0..1, label), signal }
// Returns { blob, mime: 'video/mp4', duration }.
export async function renderSceneVideo({ audio, title, bg = null, lyrics = null, anim = 'slide', onProgress = () => {}, signal = null }) {
  if (!canRender()) throw new Error('This browser cannot make video. Use Chrome or Edge on a computer.');
  const stop = () => { if (signal?.aborted) throw new Error('Cancelled.'); };

  onProgress(0, 'Reading the audio');
  const buf = await decodeAudio(audio);
  const duration = buf.duration;
  if (duration > MAX_SECONDS + 0.5) throw new Error('A video can be made for up to 10 minutes of audio.');
  const channels = Math.min(2, buf.numberOfChannels);
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
  }

  // Can this browser encode what we need?
  const vConfig = { codec: 'avc1.42001f', width: SCENE_W, height: SCENE_H, bitrate: 900_000, framerate: FPS, avc: { format: 'avc' } };
  const vs = await VideoEncoder.isConfigSupported(vConfig).catch(() => ({ supported: false }));
  if (!vs.supported) throw new Error('This browser cannot encode H.264 video. Use Chrome or Edge on a computer.');
  if (!(await canEncodeAac(channels))) throw new Error('This browser cannot encode AAC audio, which an MP4 needs. Use Chrome or Edge on Windows or Mac.');

  const [mark, bgImg] = await Promise.all([logo(), bg ? createImageBitmap(bg).catch(() => null) : null]);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(SCENE_W, SCENE_H) : Object.assign(document.createElement('canvas'), { width: SCENE_W, height: SCENE_H });
  const ctx = canvas.getContext('2d');

  // ---- encoders collect their output in memory; the MP4 is written at the end
  const vOut = [];
  let avcC = null;
  let failure = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      if (meta?.decoderConfig?.description && !avcC) avcC = new Uint8Array(meta.decoderConfig.description);
      vOut.push({ d, ts: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (e) => { failure = e; },
  });
  venc.configure(vConfig);
  try {
    // ---- video: one drawn frame at a time
    const frames = Math.max(1, Math.round(duration * FPS));
    const frameUs = Math.round(1e6 / FPS);
    for (let i = 0; i < frames; i++) {
      stop();
      if (failure) throw failure;
      const t = i / FPS;
      drawScene(ctx, SCENE_W, SCENE_H, { t, bars: barsFromSamples(mono, SR, t * SR, 32), title, bg: bgImg, mark, lyrics, anim });
      const frame = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
      venc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 6) await tick();      // let the encoder catch up
      if (i % 12 === 0) { onProgress((i / frames) * 0.85, 'Drawing the video'); await tick(); }
    }
    await venc.flush();
    if (failure) throw failure;
  } finally {
    try { venc.close(); } catch { /* already closed */ }
  }

  if (!avcC || !vOut.length) throw new Error('The browser did not return any video. Try Chrome or Edge on a computer.');
  const sound = await encodeAac(buf, { channels, signal, onProgress: (p) => onProgress(0.85 + p * 0.1, 'Encoding the sound') });
  onProgress(0.96, 'Putting the file together');
  const w = new Mp4Writer({ video: { width: SCENE_W, height: SCENE_H, avcC }, audio: { channels, sampleRate: SR, asc: sound.asc } });
  vOut.sort((a, b) => a.ts - b.ts);
  vOut.forEach((f, i) => w.addVideo(f.d, f.ts, i < vOut.length - 1 ? vOut[i + 1].ts - f.ts : Math.round(1e6 / FPS), f.key));
  sound.frames.forEach((d) => w.addAudio(d, 1024));
  const blob = w.finish();
  onProgress(1, 'Done');
  return { blob, mime: 'video/mp4', duration };
}
