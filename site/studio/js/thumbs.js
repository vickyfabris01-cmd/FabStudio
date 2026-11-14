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

export async function thumbFromImage(file) {
  const bmp = await createImageBitmap(file);
  const c = fit(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return toJpeg(c);
}

export function thumbFromVideo(blob, at = 1) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const fail = () => { URL.revokeObjectURL(url); reject(new Error('Could not read a frame from the video.')); };
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onerror = fail;
    v.onloadedmetadata = () => { v.currentTime = Math.min(at, (v.duration || 2) / 2); };
    v.onseeked = async () => {
      try {
        const c = fit(v.videoWidth || W, v.videoHeight || H);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(await toJpeg(c));
      } catch { fail(); }
    };
    v.src = url;
  });
}

function wrap(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
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

// A simple designed card: the poem title on a dark background with the FabisPot signature.
export async function thumbFromTitle(title, label = 'Fabris Poet') {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#14121a');
  g.addColorStop(1, '#241f30');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(134,196,173,0.14)';
  ctx.beginPath();
  ctx.arc(W - 170, 150, 260, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#86c4ad';
  ctx.fillRect(90, 250, 90, 6);
  ctx.fillStyle = '#ebe5d8';
  ctx.font = '600 84px Georgia, "Times New Roman", serif';
  ctx.textBaseline = 'top';
  wrap(ctx, title || 'Untitled', W - 220, 4).forEach((l, i) => ctx.fillText(l, 90, 290 + i * 100));
  ctx.fillStyle = '#86c4ad';
  ctx.font = '600 34px Georgia, serif';
  ctx.fillText('FabisPot', 90, H - 100);
  ctx.fillStyle = '#9a93a8';
  ctx.font = '30px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(label, W - 90, H - 98);
  return toJpeg(c);
}
