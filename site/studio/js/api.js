// Talks to the FabStudio Worker. Large files go up in 8 MB parts and can resume.
import { CONFIG } from '../../shared/config.js';
import { getToken } from './auth.js';
import { db } from './db.js';

const PART = 8 * 1024 * 1024;
const q = encodeURIComponent;

// Other modules listen here to see how far an upload has got. detail = { key, loaded, total }, in bytes.
export const uploadEvents = new EventTarget();
const report = (key, loaded, total) => uploadEvents.dispatchEvent(new CustomEvent('progress', { detail: { key, loaded, total } }));

async function call(path, { method = 'GET', json, body, headers = {} } = {}) {
  const token = await getToken();
  if (!token) throw new Error('not-signed-in');
  const res = await fetch(CONFIG.API_BASE + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  if (!res.ok) {
    const err = new Error(`api-${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// A PUT that tells how many bytes have been sent (fetch cannot do that). Resolves with the response text.
async function put(path, body, headers, onBytes) {
  const token = await getToken();
  if (!token) throw new Error('not-signed-in');
  return await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', CONFIG.API_BASE + path);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onBytes(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.responseText);
      const err = new Error(`api-${xhr.status}`);
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new TypeError('Failed to fetch'));
    xhr.ontimeout = () => reject(new TypeError('Failed to fetch'));
    xhr.send(body);
  });
}

export async function uploadBlob(key, blob) {
  const type = blob.type || 'application/octet-stream';
  const size = blob.size;
  if (size <= PART) {
    report(key, 0, size);
    await put(`/upload/object?key=${q(key)}`, blob, { 'Content-Type': type }, (n) => report(key, n, size));
    report(key, size, size);
    return;
  }
  let st = await db.uploads.get(key);
  if (!st || st.size !== blob.size) {
    const r = await (await call('/upload/start', { method: 'POST', json: { key, contentType: type, size: blob.size } })).json();
    st = { key, uploadId: r.uploadId, size: blob.size, parts: [] };
    await db.uploads.put(st);
  }
  const total = Math.ceil(size / PART);
  report(key, Math.min(size, st.parts.length * PART), size); // parts sent earlier count too
  try {
    for (let n = st.parts.length + 1; n <= total; n++) {
      const base = (n - 1) * PART;
      const chunk = blob.slice(base, n * PART);
      const text = await put(`/upload/part?key=${q(key)}&uploadId=${q(st.uploadId)}&partNumber=${n}`, chunk, {}, (sent) => report(key, base + sent, size));
      const r = JSON.parse(text);
      st.parts.push({ partNumber: n, etag: r.etag });
      await db.uploads.put(st);
      report(key, Math.min(size, n * PART), size);
    }
    await call('/upload/complete', { method: 'POST', json: { key, uploadId: st.uploadId, parts: st.parts } });
    await db.uploads.delete(key);
    report(key, size, size);
  } catch (e) {
    if (e.status === 404 || e.status === 400) await db.uploads.delete(key); // upload expired: start over next sync
    throw e;
  }
}

export async function deleteMedia(key) {
  await call(`/upload/object?key=${q(key)}`, { method: 'DELETE' });
}

export async function fetchMedia(key) {
  return await (await call(`/media?key=${q(key)}`)).blob();
}

// ---- Phase 2: publishing (each needs internet and the owner's sign-in)
export async function publishItem(itemId, mediaKey, thumbKey) {
  return await (await call('/publish', { method: 'POST', json: { itemId, mediaKey, thumbKey } })).json();
}
export async function unpublishItem(itemId) {
  await call('/unpublish', { method: 'POST', json: { itemId } });
}
export async function deleteItemFiles(itemId) {
  await call('/item/delete', { method: 'POST', json: { itemId } });
}
