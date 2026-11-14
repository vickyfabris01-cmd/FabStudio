// Talks to the FabStudio Worker. Large files go up in 8 MB parts and can resume.
import { CONFIG } from '../../shared/config.js';
import { getToken } from './auth.js';
import { db } from './db.js';

const PART = 8 * 1024 * 1024;
const q = encodeURIComponent;

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

export async function uploadBlob(key, blob) {
  const type = blob.type || 'application/octet-stream';
  if (blob.size <= PART) {
    await call(`/upload/object?key=${q(key)}`, { method: 'PUT', body: blob, headers: { 'Content-Type': type } });
    return;
  }
  let st = await db.uploads.get(key);
  if (!st || st.size !== blob.size) {
    const r = await (await call('/upload/start', { method: 'POST', json: { key, contentType: type, size: blob.size } })).json();
    st = { key, uploadId: r.uploadId, size: blob.size, parts: [] };
    await db.uploads.put(st);
  }
  const total = Math.ceil(blob.size / PART);
  try {
    for (let n = st.parts.length + 1; n <= total; n++) {
      const chunk = blob.slice((n - 1) * PART, n * PART);
      const r = await (await call(`/upload/part?key=${q(key)}&uploadId=${q(st.uploadId)}&partNumber=${n}`, { method: 'PUT', body: chunk })).json();
      st.parts.push({ partNumber: n, etag: r.etag });
      await db.uploads.put(st);
    }
    await call('/upload/complete', { method: 'POST', json: { key, uploadId: st.uploadId, parts: st.parts } });
    await db.uploads.delete(key);
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
