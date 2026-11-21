// The animated screen of an audio item, drawn on a canvas. ONE drawing function is used everywhere so it always looks
// the same: in the public player (live, from the playing sound), in the Studio preview and thumbnail frame picker,
// and frame by frame when the video file is made.
//
// A scene is a list of layers, bottom to top:
//   1. background  : a picture (darkened) or the dark brand colour with a slow glow
//   2. brand       : "Fabris Poet" with the mark, and the item title
//   3. bars        : sound bars that follow the music
//   4. lyrics      : one timed line at a time (optional), with an animation
// Everything is a function of the time `t` (seconds into the audio) and the bar levels, so any frame can be drawn
// on its own, which is what lets a thumbnail be "the frame at 0:42".
export const SCENE_W = 1280;
export const SCENE_H = 720;
export const LYRIC_ANIMS = [
  ['slide', 'Slide up'],
  ['fade', 'Fade'],
  ['type', 'Typewriter'],
  ['words', 'Word by word'],
];
export const defaultScene = () => ({ template: 'classic', lyricAnim: 'slide' });

const BG = '#14121a';
const SURFACE = '#1d1a25';
const TEXT = '#ebe5d8';
const MUTED = '#9a93a8';
const ACCENT = '#86c4ad';
const SERIF = "Georgia, 'Times New Roman', serif";

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);

// Breaks text into lines that fit maxW with the font currently set on ctx.
export function wrapText(ctx, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// Index of the lyric line showing at time t, or -1 in a quiet moment (no line is shown in the gaps).
export function lyricAt(lyrics, t) {
  if (!lyrics || !lyrics.length) return -1;
  let lo = 0;
  let hi = lyrics.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lyrics[mid];
    if (t < l.s) hi = mid - 1; else if (t >= l.e) lo = mid + 1; else return mid;
  }
  return -1;
}

function drawCover(ctx, img, W, H) {
  const iw = img.videoWidth || img.naturalWidth || img.width;
  const ih = img.videoHeight || img.naturalHeight || img.height;
  if (!iw || !ih) return false;
  const s = Math.max(W / iw, H / ih);
  ctx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
  return true;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawLyric(ctx, W, H, line, t, anim) {
  const dur = Math.max(0.2, line.e - line.s);
  const p = t - line.s;
  const a = Math.min(easeOut(p / 0.35), easeOut((line.e - t) / 0.3));
  if (a <= 0.01) return;
  const size = Math.round(H * 0.062);
  ctx.font = `${size}px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapText(ctx, line.t, W * 0.78);
  const lh = size * 1.28;
  const total = lines.length * lh;
  const dy = anim === 'slide' ? (1 - easeOut(p / 0.5)) * H * 0.04 : 0;
  const top = H * 0.48 - total / 2 + lh / 2 + dy;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.shadowColor = 'rgba(0,0,0,.65)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  if (anim === 'type') {
    const all = lines.join('').length;
    let shown = Math.floor(all * clamp(p / (dur * 0.6)));
    lines.forEach((l, i) => {
      const part = l.slice(0, Math.max(0, Math.min(l.length, shown)));
      shown -= l.length;
      ctx.textAlign = 'left';
      const x = (W - ctx.measureText(l).width) / 2;          // keep the line where it will end up
      ctx.fillStyle = TEXT;
      ctx.fillText(part, x, top + i * lh);
    });
  } else if (anim === 'words') {
    const nWords = lines.reduce((n, l) => n + l.split(' ').length, 0);
    const prog = clamp(p / (dur * 0.85)) * nWords;
    let wi = 0;
    lines.forEach((l, i) => {
      const words = l.split(' ');
      const space = ctx.measureText(' ').width;
      const widths = words.map((w) => ctx.measureText(w).width);
      let x = (W - (widths.reduce((s, w) => s + w, 0) + space * (words.length - 1))) / 2;
      ctx.textAlign = 'left';
      words.forEach((w, k) => {
        const lit = clamp(prog - wi);                          // 0 = not yet, 1 = fully lit
        ctx.fillStyle = lit >= 1 ? TEXT : lit > 0 ? ACCENT : MUTED;
        ctx.fillText(w, x, top + i * lh);
        x += widths[k] + space;
        wi++;
      });
    });
  } else {
    ctx.fillStyle = TEXT;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, top + i * lh));
  }
  ctx.restore();
}

// st: { t, bars: [0..1], title, bg (image or null), mark (image or null), lyrics: [{s,e,t}] or null, anim }
export function drawScene(ctx, W, H, st) {
  const t = st.t || 0;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // 1. background: a picture, darkened, or a slow glow
  if (st.bg && drawCover(ctx, st.bg, W, H)) {
    ctx.fillStyle = 'rgba(20,18,26,.58)';
    ctx.fillRect(0, 0, W, H);
  }
  const breath = 0.5 + 0.5 * Math.sin(t * 0.9);
  const g = ctx.createRadialGradient(W / 2, H * 0.48, 10, W / 2, H * 0.48, H * (0.55 + 0.08 * breath));
  g.addColorStop(0, st.bg ? 'rgba(134,196,173,.10)' : `rgba(134,196,173,${0.16 + 0.06 * breath})`);
  g.addColorStop(1, 'rgba(20,18,26,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // darker edges
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,.45)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

  // 2. brand and title
  const pad = W * 0.045;
  if (st.mark) {
    const m = H * 0.075;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(st.mark, pad, H * 0.05, m, m);
    ctx.globalAlpha = 1;
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = MUTED;
  ctx.font = `${Math.round(H * 0.032)}px ${SERIF}`;
  ctx.fillText('FABRIS POET', pad + (st.mark ? H * 0.095 : 0), H * 0.05 + H * 0.0375);
  if (st.title) {
    ctx.textAlign = 'center';
    ctx.fillStyle = TEXT;
    ctx.font = `italic ${Math.round(H * 0.05)}px ${SERIF}`;
    let title = String(st.title);
    const maxW = W * 0.8;
    while (title.length > 4 && ctx.measureText(title).width > maxW) title = title.slice(0, -2);
    if (title !== st.title) title = title.trimEnd() + '…';
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 8;
    ctx.fillText(title, W / 2, H * 0.17);
    ctx.shadowBlur = 0;
  }

  // 3. bars (mirrored around a baseline)
  const bars = st.bars && st.bars.length ? st.bars : new Array(32).fill(0);
  const n = bars.length;
  const total = W * 0.62;
  const gap = total / n * 0.34;
  const bw = total / n - gap;
  const base = H * 0.76;                 // kept above the player's controls, which cover the bottom of the screen
  const maxH = H * 0.065;
  ctx.fillStyle = ACCENT;
  for (let i = 0; i < n; i++) {
    const level = clamp(bars[i]);
    const hh = Math.max(H * 0.004, level * maxH);
    const x = (W - total) / 2 + i * (bw + gap) + gap / 2;
    ctx.globalAlpha = 0.55 + 0.4 * level;
    roundRect(ctx, x, base - hh, bw, hh * 2, bw / 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 4. lyrics (nothing is drawn in quiet moments)
  const k = lyricAt(st.lyrics, t);
  if (k >= 0) drawLyric(ctx, W, H, st.lyrics[k], t, st.anim || 'slide');
  ctx.restore();
}

// Bar levels (0..1) from raw sound, without any browser audio features, so the same bars can be computed while
// making a video (frame by frame, faster than real time). Uses the Goertzel method at `n` spread-out frequencies.
export function barsFromSamples(samples, sampleRate, centre, n = 32, win = 1024) {
  const out = new Array(n);
  const start = Math.max(0, Math.min(samples.length - win, Math.round(centre - win / 2)));
  const x = samples.subarray(start, start + win);
  if (x.length < win) return out.fill(0);
  const hann = (i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
  for (let b = 0; b < n; b++) {
    // log-spaced between 80 Hz and 8 kHz
    const f = 80 * Math.pow(100, b / (n - 1));
    const w = (2 * Math.PI * f) / sampleRate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < win; i++) {
      const s0 = x[i] * hann(i) + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    const mag = Math.sqrt(Math.max(0, power)) / (win / 4);
    out[b] = Math.min(1, Math.pow(mag * 6, 0.6));
  }
  return out;
}
