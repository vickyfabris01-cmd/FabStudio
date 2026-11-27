// A small MP4 writer (ISO base media file), used in the browser for two jobs:
//   - taking the sound out of an MP4 video without re-encoding it (an .m4a file), see mp4-audio.js
//   - putting encoded video + audio into one MP4 (a video file)
// The file is written "progressive": the index (moov) comes first, so it starts playing before it is fully loaded.
// Samples are kept in memory (a 10 minute item is a few tens of MB). No frameworks, no libraries.

const enc = new TextEncoder();
const u8 = (...n) => Uint8Array.from(n);
const be16 = (n) => u8((n >> 8) & 255, n & 255);
const be32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const cat = (...parts) => {
  const flat = parts.flat(Infinity).filter((p) => p != null);
  let len = 0;
  for (const p of flat) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of flat) { out.set(p, o); o += p.length; }
  return out;
};
const box = (type, ...parts) => { const body = cat(...parts); return cat(be32(body.length + 8), enc.encode(type), body); };
const fullBox = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
const zeros = (n) => new Uint8Array(n);
const MATRIX = cat(be32(0x00010000), be32(0), be32(0), be32(0), be32(0x00010000), be32(0), be32(0), be32(0), be32(0x40000000));

// MPEG-4 descriptor length: one byte per 7 bits, the last without the top bit.
const descLen = (n) => (n < 128 ? u8(n) : n < 16384 ? u8(0x80 | (n >> 7), n & 127) : u8(0x80 | (n >> 14), 0x80 | ((n >> 7) & 127), n & 127));
const desc = (tag, ...parts) => { const body = cat(...parts); return cat(u8(tag), descLen(body.length), body); };

// The "esds" box of an AAC track. `asc` is the AudioSpecificConfig (2 bytes for AAC-LC).
function esds(asc, bitrate = 128000) {
  const dec = desc(0x04, u8(0x40, 0x15), u8(0, 0, 0), be32(bitrate), be32(bitrate), desc(0x05, asc));
  const sl = desc(0x06, u8(0x02));
  return fullBox('esds', 0, 0, desc(0x03, be16(0), u8(0), dec, sl));
}

function mp4aEntry({ channels, sampleRate, asc }) {
  return box('mp4a', zeros(6), be16(1), zeros(8), be16(channels), be16(16), be16(0), be16(0), be32(Math.min(sampleRate, 65535) * 65536), esds(asc));
}

function avc1Entry({ width, height, avcC }) {
  const name = zeros(32);
  return box('avc1', zeros(6), be16(1), zeros(16), be16(width), be16(height), be32(0x00480000), be32(0x00480000), be32(0), be16(1), name, be16(0x18), be16(0xffff), box('avcC', avcC));
}

const handler = (type, name) => fullBox('hdlr', 0, 0, be32(0), enc.encode(type), zeros(12), enc.encode(name + '\0'));
const dinf = () => box('dinf', fullBox('dref', 0, 0, be32(1), fullBox('url ', 0, 1)));

// Run-length list for stts: [[count, delta], ...]
function rle(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++; else out.push([1, v]);
  }
  return out;
}

export class Mp4Writer {
  // video: { width, height, avcC: Uint8Array, timescale?: 90000 }
  // audio: { channels, sampleRate, asc: Uint8Array }   or   { channels, sampleRate, timescale, entry: Uint8Array (a ready mp4a box) }
  // brand: 'isom' (video, default) or 'M4A '
  constructor({ video = null, audio = null, brand = 'isom' } = {}) {
    this.video = video ? { ...video, timescale: video.timescale || 90000, samples: [] } : null;
    this.audio = audio ? { ...audio, timescale: audio.timescale || audio.sampleRate, samples: [] } : null;
    this.brand = brand;
  }

  // One encoded video frame (in length-prefixed "AVCC" form). Frames must be added in display order (no B-frames).
  addVideo(data, timestampUs, durationUs, key) {
    this.video.samples.push({ data, ts: timestampUs, durHint: durationUs, key: !!key });
  }

  // One encoded audio frame. durTicks is its length in audio ticks (1024 for AAC), which keeps audio exactly in step.
  addAudio(data, durTicks) {
    this.audio.samples.push({ data, dur: durTicks });
  }

  // Turns timestamps into durations in track ticks.
  #prepare() {
    const v = this.video;
    if (v) {
      const n = v.samples.length;
      const ticks = v.samples.map((s) => Math.round((s.ts * v.timescale) / 1e6));
      v.samples.forEach((s, i) => {
        s.dur = i < n - 1 ? Math.max(1, ticks[i + 1] - ticks[i]) : Math.max(1, Math.round((s.durHint * v.timescale) / 1e6));
      });
    }
  }

  #chunks() {
    // Interleave: about half a second of one track, then half a second of the other, in time order.
    const tracks = [this.video, this.audio].filter(Boolean);
    const state = tracks.map((t) => ({ t, i: 0, time: 0 }));
    const chunks = [];
    for (;;) {
      const live = state.filter((s) => s.i < s.t.samples.length);
      if (!live.length) break;
      live.sort((a, b) => a.time / a.t.timescale - b.time / b.t.timescale);
      const s = live[0];
      const start = s.i;
      let ticks = 0;
      while (s.i < s.t.samples.length && ticks < s.t.timescale / 2) { ticks += s.t.samples[s.i].dur; s.i++; }
      s.time += ticks;
      chunks.push({ track: s.t, first: start, count: s.i - start });
    }
    return chunks;
  }

  #trak(t, id, kind, offsets) {
    const samples = t.samples;
    const total = samples.reduce((n, s) => n + s.dur, 0);
    const movieDur = Math.round((total * 1000) / t.timescale);
    const isVideo = kind === 'vide';
    const stsd = fullBox('stsd', 0, 0, be32(1), isVideo ? avc1Entry(t) : (t.entry || mp4aEntry(t)));
    const runs = rle(samples.map((s) => s.dur));
    const sttsBox = fullBox('stts', 0, 0, be32(runs.length), runs.map(([c, d]) => cat(be32(c), be32(d))));
    const syncs = isVideo ? samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean) : [];
    const stss = isVideo ? fullBox('stss', 0, 0, be32(syncs.length), syncs.map(be32)) : null;
    // chunk table of this track: samples per chunk, run-length coded
    const mine = offsets.filter((c) => c.track === t);
    const stscRows = [];
    mine.forEach((c, i) => {
      const last = stscRows[stscRows.length - 1];
      if (!last || last[1] !== c.count) stscRows.push([i + 1, c.count, 1]);
    });
    const stsc = fullBox('stsc', 0, 0, be32(stscRows.length), stscRows.map((r) => cat(be32(r[0]), be32(r[1]), be32(r[2]))));
    const stsz = fullBox('stsz', 0, 0, be32(0), be32(samples.length), samples.map((s) => be32(s.data.length)));
    const stco = fullBox('stco', 0, 0, be32(mine.length), mine.map((c) => be32(c.offset)));
    const stbl = box('stbl', stsd, sttsBox, stss, stsc, stsz, stco);
    const minf = box('minf', isVideo ? fullBox('vmhd', 0, 1, be16(0), zeros(6)) : fullBox('smhd', 0, 0, be16(0), be16(0)), dinf(), stbl);
    const mdia = box('mdia', fullBox('mdhd', 0, 0, be32(0), be32(0), be32(t.timescale), be32(total), be16(0x55c4), be16(0)),
      handler(kind, isVideo ? 'VideoHandler' : 'SoundHandler'), minf);
    const tkhd = fullBox('tkhd', 0, 3, be32(0), be32(0), be32(id), be32(0), be32(movieDur), zeros(8), be16(0), be16(0), be16(isVideo ? 0 : 0x0100), be16(0),
      MATRIX, be32(isVideo ? t.width * 65536 : 0), be32(isVideo ? t.height * 65536 : 0));
    return { trak: box('trak', tkhd, mdia), movieDur };
  }

  #moov(offsets) {
    const traks = [];
    let dur = 0;
    let id = 1;
    for (const [t, kind] of [[this.video, 'vide'], [this.audio, 'soun']]) {
      if (!t || !t.samples.length) continue;
      const r = this.#trak(t, id++, kind, offsets);
      traks.push(r.trak);
      dur = Math.max(dur, r.movieDur);
    }
    const mvhd = fullBox('mvhd', 0, 0, be32(0), be32(0), be32(1000), be32(dur), be32(0x00010000), be16(0x0100), be16(0), zeros(8), MATRIX, zeros(24), be32(id));
    return box('moov', mvhd, ...traks);
  }

  // Builds the file and returns it as a Blob.
  finish() {
    this.#prepare();
    const chunks = this.#chunks();
    const ftyp = box('ftyp', enc.encode(this.brand), be32(512), enc.encode(this.brand), enc.encode('isom'), enc.encode('iso2'), enc.encode('mp42'), this.video ? enc.encode('avc1') : null);
    // The index size does not depend on the offsets, so build it once to measure, then again with real offsets.
    const place = (base) => {
      let o = base;
      const list = chunks.map((c) => {
        const size = c.track.samples.slice(c.first, c.first + c.count).reduce((n, s) => n + s.data.length, 0);
        const r = { track: c.track, first: c.first, count: c.count, offset: o, size };
        o += size;
        return r;
      });
      return { list, end: o };
    };
    const measure = this.#moov(place(0).list).length;
    const base = ftyp.length + measure + 8;
    const { list, end } = place(base);
    const moov = this.#moov(list);
    const dataSize = end - base;
    const parts = [ftyp, moov, cat(be32(dataSize + 8), enc.encode('mdat'))];
    for (const c of list) for (let i = c.first; i < c.first + c.count; i++) parts.push(c.track.samples[i].data);
    return new Blob(parts, { type: this.video ? 'video/mp4' : 'audio/mp4' });
  }
}

export { mp4aEntry, avc1Entry };
