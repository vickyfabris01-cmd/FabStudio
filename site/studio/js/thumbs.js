// Thumbnails: from an uploaded image, from the title, or from a frame of a video.
// All are JPEG, at most 1280 px wide, so pages and link previews load fast.
const W = 1280;
const H = 720;

const toJpeg = (canvas, quality = 0.85) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the image.'))), 'image/jpeg', quality));

function fit(srcW, srcH) {
  const scale = Math.min(1, W / srcW);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(srcW * scale));
  c.height = Math.max(1, Math.round(srcH * scale));
  return c;
}

// Draws a picture to fill a w x h box (cover). zoom 1 to 3 enlarges it; ox and oy (-1 to 1) slide it inside the box.
export function drawCover(ctx, src, sw, sh, w, h, zoom = 1, ox = 0, oy = 0) {
  const base = Math.max(w / sw, h / sh) * Math.max(1, zoom);
  const dw = sw * base; const dh = sh * base;
  const x = (w - dw) / 2 + ox * ((dw - w) / 2);
  const y = (h - dh) / 2 + oy * ((dh - h) / 2);
  ctx.drawImage(src, x, y, dw, dh);
}

// Every thumbnail is a 16:9 card, so the home page grid and link previews all line up.
export async function thumbFromBitmap(bmp, { zoom = 1, ox = 0, oy = 0 } = {}) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#14121a'; ctx.fillRect(0, 0, W, H);
  drawCover(ctx, bmp, bmp.width, bmp.height, W, H, zoom, ox, oy);
  return toJpeg(c);
}

export async function thumbFromImage(file) {
  const bmp = await createImageBitmap(file);
  try { return await thumbFromBitmap(bmp); } finally { bmp.close?.(); }
}

// A frame of a video as a 16:9 card. With no time given it takes a frame near the start; with one it goes exactly there.
export function thumbFromVideo(blob, at) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const fail = () => { URL.revokeObjectURL(url); reject(new Error('Could not read a frame from the video.')); };
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onerror = fail;
    v.onloadedmetadata = () => { v.currentTime = at == null ? Math.min(1, (v.duration || 2) / 2) : Math.max(0, Math.min(at, (v.duration || 1) - 0.1)); };
    v.onseeked = async () => {
      try {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#14121a'; ctx.fillRect(0, 0, W, H);
        drawCover(ctx, v, v.videoWidth || W, v.videoHeight || H, W, H);
        URL.revokeObjectURL(url);
        resolve(await toJpeg(c));
      } catch { fail(); }
    };
    v.src = url;
  });
}

function wrap(ctx, text, maxWidth, maxLines) {
  // A word wider than the card (a file name with underscores, say) is cut into pieces so it never runs off the edge.
  const words = text.split(/\s+/).filter(Boolean).flatMap((w) => {
    if (ctx.measureText(w).width <= maxWidth) return [w];
    const parts = [];
    let cur = '';
    for (const ch of w) {
      if (cur && ctx.measureText(cur + ch).width > maxWidth) { parts.push(cur); cur = ch; } else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  });
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

const loadImg = (src) => new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });

// Looks for the title card. Number 0 is the original; "Redraw" steps through the others.
export const TITLE_LOOKS = [
  { a: '#14121a', b: '#241f30', accent: '#86c4ad', ring: 'rgba(134,196,173,0.14)', at: [W - 170, 150, 260] },
  { a: '#1a1218', b: '#35202c', accent: '#e8a3b8', ring: 'rgba(232,163,184,0.15)', at: [170, H - 120, 250] },
  { a: '#101a1b', b: '#1b3236', accent: '#8fd0e0', ring: 'rgba(143,208,224,0.14)', at: [W - 120, H - 90, 300] },
  { a: '#1a1811', b: '#35311d', accent: '#e3c47c', ring: 'rgba(227,196,124,0.15)', at: [W - 260, 110, 200] },
  { a: '#15111f', b: '#2c2350', accent: '#b8a0f4', ring: 'rgba(184,160,244,0.16)', at: [W / 2 + 120, H + 20, 330] },
  { a: '#1b1313', b: '#3b211f', accent: '#ea7e74', ring: 'rgba(234,126,116,0.15)', at: [120, 120, 220] },
];

// A simple designed card: the poem title on a dark background with the Fabris Poet mark.
export async function thumbFromTitle(title, label = 'Fabris Poet', look = 0) {
  const L = TITLE_LOOKS[((look % TITLE_LOOKS.length) + TITLE_LOOKS.length) % TITLE_LOOKS.length];
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, L.a);
  g.addColorStop(1, L.b);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = L.ring;
  ctx.beginPath();
  ctx.arc(L.at[0], L.at[1], L.at[2], 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = L.accent;
  ctx.fillRect(90, 250, 90, 6);
  ctx.fillStyle = '#ebe5d8';
  ctx.font = '600 84px Georgia, "Times New Roman", serif';
  ctx.textBaseline = 'top';
  wrap(ctx, title || 'Untitled', W - 220, 4).forEach((l, i) => ctx.fillText(l, 90, 290 + i * 100));
  const mark = await loadImg('/studio/icons/mark.png');
  if (mark) {
    const mh = 96;
    ctx.drawImage(mark, 90, H - 64 - mh, Math.round((mark.width * mh) / mark.height), mh);
  } else {
    ctx.fillStyle = L.accent;
    ctx.font = '600 34px Georgia, serif';
    ctx.fillText('FabisPot', 90, H - 100);
  }
  ctx.fillStyle = '#9a93a8';
  ctx.font = '30px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(label, W - 90, H - 98);
  return toJpeg(c);
}
