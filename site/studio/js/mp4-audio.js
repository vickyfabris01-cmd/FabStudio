// Takes the sound out of an MP4 video without re-encoding it: the audio samples are copied as they are into a
// new .m4a file. Nothing is lost and it takes about a second. Only normal MP4 files with an AAC (mp4a) audio
// track are handled; anything else returns null and the Studio asks you to add the audio version yourself.
import { Mp4Writer } from './mp4-mux.js';

const type4 = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);

// Lists the boxes found in u[start..end).
function boxes(u, dv, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = type4(u, o + 4);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) break;
    out.push({ type, body: o + hdr, end: o + size });
    o += size;
  }
  return out;
}
const find = (list, t) => list.find((b) => b.type === t);

// Finds the moov box (the index) without reading the whole file.
async function readMoov(blob) {
  let pos = 0;
  while (pos + 8 <= blob.size) {
    const head = new Uint8Array(await blob.slice(pos, pos + 16).arrayBuffer());
    const dv = new DataView(head.buffer);
    let size = dv.getUint32(0);
    const type = type4(head, 4);
    if (size === 1) size = Number(dv.getBigUint64(8)); else if (size === 0) size = blob.size - pos;
    if (type === 'moof') return null;                 // fragmented MP4: not handled
    if (size < 8) return null;
    if (type === 'moov') return new Uint8Array(await blob.slice(pos, pos + size).arrayBuffer());
    pos += size;
  }
  return null;
}

// Returns { blob, mime: 'audio/mp4', duration } or null when there is no usable audio track.
export async function extractAudio(blob) {
  const moov = await readMoov(blob);
  if (!moov) return null;
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const top = boxes(moov, dv, 0, moov.length)[0];          // the moov box itself
  if (!top || top.type !== 'moov') return null;
  for (const trak of boxes(moov, dv, top.body, top.end).filter((b) => b.type === 'trak')) {
    const mdia = find(boxes(moov, dv, trak.body, trak.end), 'mdia');
    if (!mdia) continue;
    const mk = boxes(moov, dv, mdia.body, mdia.end);
    const hdlr = find(mk, 'hdlr');
    if (!hdlr || type4(moov, hdlr.body + 8) !== 'soun') continue;
    const mdhd = find(mk, 'mdhd');
    const timescale = dv.getUint32(mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12));
    const minf = find(mk, 'minf');
    const stbl = find(boxes(moov, dv, minf.body, minf.end), 'stbl');
    const st = boxes(moov, dv, stbl.body, stbl.end);
    const stsd = find(st, 'stsd'), stts = find(st, 'stts'), stsc = find(st, 'stsc'), stsz = find(st, 'stsz');
    const stco = find(st, 'stco') || find(st, 'co64');
    if (!stsd || !stts || !stsc || !stsz || !stco) return null;

    // the sample entry (must be AAC-style "mp4a")
    const eo = stsd.body + 8;
    const eSize = dv.getUint32(eo);
    if (type4(moov, eo + 4) !== 'mp4a') return null;
    const entry = moov.slice(eo, eo + eSize);
    const channels = dv.getUint16(eo + 24);
    const sampleRate = dv.getUint32(eo + 32) >>> 16;

    // sample sizes, durations, and where each chunk starts
    const count = dv.getUint32(stsz.body + 8);
    const fixed = dv.getUint32(stsz.body + 4);
    const sizes = new Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.body + 12 + i * 4);
    const durs = [];
    const nT = dv.getUint32(stts.body + 4);
    for (let i = 0; i < nT; i++) {
      const c = dv.getUint32(stts.body + 8 + i * 8), d = dv.getUint32(stts.body + 12 + i * 8);
      for (let k = 0; k < c; k++) durs.push(d);
    }
    const big = stco.type === 'co64';
    const nC = dv.getUint32(stco.body + 4);
    const chunkOff = new Array(nC);
    for (let i = 0; i < nC; i++) chunkOff[i] = big ? Number(dv.getBigUint64(stco.body + 8 + i * 8)) : dv.getUint32(stco.body + 8 + i * 4);
    const nS = dv.getUint32(stsc.body + 4);
    const rows = [];
    for (let i = 0; i < nS; i++) rows.push([dv.getUint32(stsc.body + 8 + i * 12), dv.getUint32(stsc.body + 12 + i * 12)]);

    const w = new Mp4Writer({ audio: { channels, sampleRate, timescale, entry }, brand: 'M4A ' });
    let s = 0;
    for (let c = 0; c < nC && s < count; c++) {
      let per = rows[0][1];
      for (const r of rows) if (r[0] <= c + 1) per = r[1];
      const n = Math.min(per, count - s);
      let total = 0;
      for (let k = 0; k < n; k++) total += sizes[s + k];
      const buf = new Uint8Array(await blob.slice(chunkOff[c], chunkOff[c] + total).arrayBuffer());
      let o = 0;
      for (let k = 0; k < n; k++) { w.addAudio(buf.subarray(o, o + sizes[s + k]), durs[s + k] || 1024); o += sizes[s + k]; }
      s += n;
    }
    if (!s) return null;
    const ticks = durs.reduce((a, b) => a + b, 0);
    return { blob: w.finish(), mime: 'audio/mp4', duration: ticks / timescale };
  }
  return null;     // no audio track
}
