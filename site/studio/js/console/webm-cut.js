// Cuts a piece out of a WebM/Opus recording WITHOUT decoding or re-encoding it, and without any download:
// the recording is read block by block (one block = one 20 ms Opus frame), and the blocks inside the chosen
// time range are written into a new, small WebM file. A 90 minute recording is read once (about 90 MB in memory,
// no decoding), so it is fast and exact to 20 ms. Only WebM is supported (what Chrome and Edge record).
//
//   const index = await indexWebm(blob);      // index.durationMs, index.blocks, index.frameSizes()
//   const clip  = cutWebm(index, startMs, endMs);   // a Blob (audio/webm)

const ID = { EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, TRACKS: 0x1654ae6b, CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7, SIMPLEBLOCK: 0xa3, BLOCKGROUP: 0xa0, BLOCK: 0xa1, TIMESCALE: 0x2ad7b1, CUES: 0x1c53bb6b, SEEKHEAD: 0x114d9b74, TAGS: 0x1254c367, VOID: 0xec };
const TOP = new Set([ID.INFO, ID.TRACKS, ID.CLUSTER, ID.CUES, ID.SEEKHEAD, ID.TAGS, ID.VOID, 0x1941a469, 0x1043a770]);   // elements that can sit directly in a Segment

// Element id (marker bits kept) and size (marker removed; null = unknown size) at position p.
function readId(b, p) {
  const first = b[p];
  if (!first) throw new Error('Not a WebM file.');
  const len = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
  if (!len) throw new Error('Not a WebM file.');
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
  return { id, len };
}
function readSize(b, p) {
  const first = b[p];
  let len = 1; let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) throw new Error('Not a WebM file.');
  let v = first & (mask - 1); let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false; }
  return { size: allOnes ? null : v, len };
}
const readUint = (b, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };

export async function indexWebm(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const end = buf.length;
  let p = 0;
  // EBML header
  const e = readId(buf, 0);
  if (e.id !== ID.EBML) throw new Error('This recording is not a WebM file, so it cannot be cut here.');
  const es = readSize(buf, e.len);
  const ebmlEnd = e.len + es.len + es.size;
  const ebml = buf.subarray(0, ebmlEnd);
  p = ebmlEnd;
  const s = readId(buf, p);
  if (s.id !== ID.SEGMENT) throw new Error('Not a WebM file.');
  const ss = readSize(buf, p + s.len);
  p += s.len + ss.len;                                   // inside the Segment
  let tracks = null; let scaleNs = 1000000; let trackNo = null;
  const t = []; const off = []; const len = [];          // per block: time (ms), frame start, frame length
  let clusterTc = 0;

  const addBlock = (q, size) => {                         // q = start of block data (track, timecode, flags, frame)
    const tn = readSize(buf, q);                          // the track number is a vint
    const hdr = tn.len + 3;
    const flags = buf[q + tn.len + 2];
    if (flags & 0x06) throw new Error('This recording uses a layout that cannot be cut here.');
    if (trackNo == null) trackNo = tn.size;
    const rel = (buf[q + tn.len] << 8) | buf[q + tn.len + 1];
    const signed = rel > 0x7fff ? rel - 0x10000 : rel;
    t.push(Math.round(((clusterTc + signed) * scaleNs) / 1e6)); off.push(q + hdr); len.push(size - hdr);
  };

  // walk a cluster's children from q up to limit (limit = end of file for a cluster of unknown size)
  const walkCluster = (q, limit, unknown) => {
    while (q < limit) {
      const c = readId(buf, q);
      if (unknown && (c.id === ID.CLUSTER || TOP.has(c.id))) return q;           // the next top-level element starts here
      const cs = readSize(buf, q + c.len);
      const body = q + c.len + cs.len;
      const size = cs.size == null ? limit - body : cs.size;
      if (c.id === ID.TIMECODE) clusterTc = readUint(buf, body, size);
      else if (c.id === ID.SIMPLEBLOCK) addBlock(body, size);
      else if (c.id === ID.BLOCKGROUP) {
        let g = body; const gEnd = body + size;
        while (g < gEnd) {
          const gi = readId(buf, g); const gs = readSize(buf, g + gi.len);
          const gb = g + gi.len + gs.len;
          if (gi.id === ID.BLOCK) addBlock(gb, gs.size);
          g = gb + gs.size;
        }
      }
      q = body + size;
    }
    return q;
  };

  while (p < end) {
    let el;
    try { el = readId(buf, p); } catch { break; }                                  // trailing garbage
    const sz = readSize(buf, p + el.len);
    const body = p + el.len + sz.len;
    if (el.id === ID.CLUSTER) {
      const unknown = sz.size == null;
      const limit = unknown ? end : Math.min(end, body + sz.size);
      p = unknown ? walkCluster(body, limit, true) : (walkCluster(body, limit, false), limit);
      continue;
    }
    if (sz.size == null) break;
    if (el.id === ID.TRACKS) tracks = buf.subarray(p, body + sz.size);
    else if (el.id === ID.INFO) {
      let q = body; const iEnd = body + sz.size;
      while (q < iEnd) { const ii = readId(buf, q); const is = readSize(buf, q + ii.len); const ib = q + ii.len + is.len; if (ii.id === ID.TIMESCALE) scaleNs = readUint(buf, ib, is.size); q = ib + is.size; }
    }
    p = body + sz.size;
  }
  if (!tracks || !t.length) throw new Error('No audio was found in this recording.');
  const times = Int32Array.from(t); const offs = Int32Array.from(off); const lens = Int32Array.from(len);
  // blocks can in theory be slightly out of order: order them by time
  let sorted = true; for (let i = 1; i < times.length; i++) if (times[i] < times[i - 1]) { sorted = false; break; }
  let order = null;
  if (!sorted) { order = Array.from(times.keys()).sort((a, b) => times[a] - times[b]); }
  const pick = (arr) => (order ? Int32Array.from(order, (i) => arr[i]) : arr);
  const T = pick(times);
  const last = T.length - 1;
  return { buf, ebml, tracks, trackNo: trackNo || 1, t: T, off: pick(offs), len: pick(lens), durationMs: T[last] - T[0] + 20, firstMs: T[0] };
}

// Size of the encoded audio per 'binMs' of the recording. Used as a rough waveform when no level history was saved.
export function frameSizes(index, binMs = 500) {
  const n = Math.max(1, Math.ceil(index.durationMs / binMs));
  const sum = new Float64Array(n); const cnt = new Float64Array(n);
  for (let i = 0; i < index.t.length; i++) { const b = Math.min(n - 1, Math.floor((index.t[i] - index.firstMs) / binMs)); sum[b] += index.len[i]; cnt[b]++; }
  return Array.from(sum, (v, i) => (cnt[i] ? v / cnt[i] : 0));
}

/* ---------- writing ---------- */
const enc = new TextEncoder();
function vintSize(n) {                                    // an EBML size with the shortest length
  let len = 1;
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}
function idBytes(id) { const out = []; let v = id; while (v > 0) { out.unshift(v % 256); v = Math.floor(v / 256); } return Uint8Array.from(out); }
const uintBytes = (v) => { const out = []; do { out.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0); return Uint8Array.from(out); };
const join = (parts) => { const total = parts.reduce((n, a) => n + a.length, 0); const out = new Uint8Array(total); let o = 0; for (const a of parts) { out.set(a, o); o += a.length; } return out; };
const el = (id, ...kids) => { const body = join(kids); return join([idBytes(id), vintSize(body.length), body]); };

// cutWebm(index, startMs, endMs)            one range (the original call, unchanged)
// cutWebm(index, [[startMs, endMs], ...])   several ranges, joined in the order given (frames are copied, nothing is
//                                           re-encoded; there may be a faint click where two pieces meet)
// Returns { blob, durationMs }.
export function cutWebm(index, startOrRanges, endMs) {
  const ranges = Array.isArray(startOrRanges) ? startOrRanges : [[startOrRanges, endMs]];
  if (!ranges.length) throw new Error('Nothing is left between those two times.');
  const base = index.firstMs;
  // frames to copy, with their new time in the joined file
  const pick = [];        // frame numbers in the source
  const newT = [];        // their time in the new file (ms)
  let acc = 0;
  for (const [startMs, stopMs] of ranges) {
    const from = Math.max(0, Math.round(startMs)) + base;
    const to = Math.min(index.durationMs, Math.round(stopMs)) + base;
    let a = 0; while (a < index.t.length && index.t[a] < from) a++;
    let b = a; while (b < index.t.length && index.t[b] < to) b++;
    if (b <= a) throw new Error('Nothing is left between those two times.');
    const t0 = index.t[a];
    for (let k = a; k < b; k++) { pick.push(k); newT.push(acc + index.t[k] - t0); }
    acc += index.t[b - 1] - t0 + 20;
  }
  const durMs = acc;
  const count = pick.length;

  const info = el(ID.INFO, el(ID.TIMESCALE, uintBytes(1000000)), el(0x4d80, enc.encode('FabStudio')), el(0x5741, enc.encode('FabStudio')),
    (() => { const d = new Uint8Array(8); new DataView(d.buffer).setFloat64(0, durMs); return el(0x4489, d); })());
  const tn = vintSize(index.trackNo);

  // clusters of about 2 seconds
  const clusters = [];                                     // { tc, bytes }
  let i = 0;
  while (i < count) {
    const tc = newT[i];
    const kids = [el(ID.TIMECODE, uintBytes(tc))];
    while (i < count && newT[i] - tc < 2000) {
      const rel = newT[i] - tc;
      const src = pick[i];
      const frame = index.buf.subarray(index.off[src], index.off[src] + index.len[src]);
      const head = Uint8Array.of(...tn, (rel >> 8) & 0xff, rel & 0xff, 0x80);
      kids.push(el(ID.SIMPLEBLOCK, head, frame));
      i++;
    }
    clusters.push({ tc, bytes: el(ID.CLUSTER, ...kids) });
  }

  // Segment of unknown size: Info, Tracks, Clusters, then Cues (so a player can jump around)
  const segHead = join([idBytes(ID.SEGMENT), Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)]);
  let pos = info.length + index.tracks.length;             // offsets inside the Segment body
  const cues = [];
  for (const c of clusters) {
    cues.push(el(0xbb, el(0xb3, uintBytes(c.tc)), el(0xb7, el(0xf7, uintBytes(1)), el(0xf1, uintBytes(pos)))));
    pos += c.bytes.length;
  }
  const cuesEl = el(ID.CUES, ...cues);
  const bytes = join([index.ebml, segHead, info, index.tracks, ...clusters.map((c) => c.bytes), cuesEl]);
  return { blob: new Blob([bytes], { type: 'audio/webm' }), durationMs: durMs };
}
