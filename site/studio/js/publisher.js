// Background publishing.
// A publish job keeps running while you move around the app, shows its progress (in percent) on every
// screen, and starts again by itself if the app was closed before it finished.
// It uses the normal sync for the uploads, so there is only ever one upload path.
import { db, now } from './db.js';
import { syncAndWait, getSyncState } from './sync.js';
import { publishItem, uploadEvents } from './api.js';
import { h, toast } from './ui.js';

const ACTIVE = ['queued', 'running', 'waiting'];
const jobs = new Map();   // item id -> { id, title, state, pct, label, error, promise }
const waitingJobs = [];   // jobs that have not started yet
const listeners = new Set();
let current = null;
let bar = null;
let lock = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const permanent = (e, silent = false) => { e.permanent = true; e.silent = silent; return e; };

/* ---------- what screens can ask ---------- */
export const jobFor = (id) => jobs.get(id) || null;
export const isBusy = (id) => { const j = jobs.get(id); return !!j && ACTIVE.includes(j.state); };
export function onPublishJobs(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/* ---------- the progress bar shown on every screen ---------- */
const CSS = `
#pubbar{display:none;position:fixed;left:0;right:0;top:var(--pubtop,3.4rem);z-index:4;padding:.45rem 1rem .55rem;background:var(--surface);border-bottom:1px solid var(--line)}
body.publishing #pubbar{display:block}
body.publishing #view{padding-top:3.7rem}
#pubbar .pb-row{display:flex;justify-content:space-between;gap:.8rem;font-size:.85rem}
#pubbar .pb-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pubbar .pb-pct{flex:none;font-variant-numeric:tabular-nums;font-weight:600;color:var(--accent)}
#pubbar progress{display:block;margin:.35rem 0 0}
body.publishing .bake-controls{top:calc(var(--pubtop,3.4rem) + 3.3rem) !important}
h1,h2,h3{overflow-wrap:anywhere}
`;
const style = document.createElement('style');
style.textContent = CSS;
document.head.append(style);

function mountBar() {
  if (bar) return bar;
  const title = h('span', { class: 'pb-title' });
  const pct = h('span', { class: 'pb-pct' });
  const prog = h('progress', { max: 100, value: 0 });
  const el = h('div', { id: 'pubbar', role: 'status' }, h('div', { class: 'pb-row' }, title, pct), prog);
  document.body.append(el);
  bar = { el, title, pct, prog };
  return bar;
}

function paintBar() {
  document.body.classList.toggle('publishing', !!current);
  if (!current) return;
  const b = mountBar();
  const header = document.querySelector('.bar');
  if (header) document.documentElement.style.setProperty('--pubtop', `calc(${header.offsetHeight}px + env(safe-area-inset-top))`);
  const more = waitingJobs.length ? ` (+${waitingJobs.length} waiting)` : '';
  b.title.textContent = `${current.label}: ${current.title || 'item'}${more}`;
  b.pct.textContent = current.pct + '%';
  b.prog.value = current.pct;
}

function change(job, patch) {
  Object.assign(job, patch);
  for (const fn of [...listeners]) { try { fn(job); } catch (e) { console.warn(e); } }
  paintBar();
}

/* ---------- keep the screen awake while publishing, so the phone does not pause the upload ---------- */
async function acquire() {
  if (lock || !current || document.hidden) return;
  try {
    lock = (await navigator.wakeLock?.request('screen')) || null;
    lock?.addEventListener('release', () => { lock = null; });
  } catch { lock = null; }
}
function release() {
  try { lock?.release(); } catch { /* already released */ }
  lock = null;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) acquire(); });

/* ---------- the job ---------- */
async function snapshot(poemId) {
  return { poemTitle: '', poemStanzas: [] }; // poem text stays in Studio and is never published
}

async function whenOnline(job) {
  if (navigator.onLine) return;
  change(job, { state: 'waiting', label: 'Waiting for internet' });
  await new Promise((resolve) => window.addEventListener('online', resolve, { once: true }));
  change(job, { state: 'running', label: 'Preparing' });
}

const gone = () => permanent(new Error('That item is gone.'), true);
const signedOut = () => permanent(new Error('Sign in again in Settings, then publish again.'));

// One try. Progress: 0-80 uploading the files, 85 copying to the public site, 95 finishing, 100 done.
async function attempt(job) {
  const id = job.id;
  await whenOnline(job);
  let row = await db.items.get(id);
  if (!row) throw gone();
  if (row.title) job.title = row.title;

  // How many bytes still have to go up, so the upload can be shown as a percentage.
  const pend = [];
  if (row.mediaPending && row.blob) pend.push([row.mediaKey, row.blob.size]);
  if (row.thumbPending && row.thumbBlob) pend.push([row.thumbKey, row.thumbBlob.size]);
  const total = pend.reduce((n, p) => n + p[1], 0);
  const sent = {};
  const onProgress = (e) => {
    const { key, loaded } = e.detail;
    if (!pend.some((p) => p[0] === key)) return;
    sent[key] = loaded;
    const done = Object.values(sent).reduce((n, v) => n + v, 0);
    change(job, { label: 'Uploading', pct: Math.max(job.pct, Math.min(80, Math.round((done / total) * 80))) });
  };
  uploadEvents.addEventListener('progress', onProgress);
  try {
    change(job, { label: total ? 'Uploading' : 'Syncing', pct: Math.max(job.pct, 1) });
    await syncAndWait();
  } finally {
    uploadEvents.removeEventListener('progress', onProgress);
  }

  row = await db.items.get(id);
  if (!row) throw gone();
  if (getSyncState().state === 'auth') throw signedOut();
  if (row.mediaPending || row.thumbPending || row.dirty) throw new Error(getSyncState().error || 'The upload did not finish.');

  change(job, { label: 'Publishing', pct: Math.max(job.pct, 85) });
  const out = await publishItem(id, row.mediaKey, row.thumbKey);

  change(job, { label: 'Finishing', pct: 95 });
  await db.items.update(id, {
    status: 'published', publishedAt: row.publishedAt || now(), publicMediaKey: out.publicMediaKey,
    publicThumbKey: out.publicThumbKey, ...(await snapshot(row.poemId)), publishRequested: 0, updatedAt: now(), dirty: 1,
  });
  await syncAndWait();
  row = await db.items.get(id);
  if (row?.dirty) throw new Error('The files are ready but the page did not update. Tap Publish again.');
}

async function run(job) {
  change(job, { state: 'running', pct: 1, label: 'Preparing' });
  try {
    for (let tries = 1; ; tries++) {
      try { await attempt(job); break; }
      catch (e) {
        // Network trouble and server errors are tried again. Anything else stops the job.
        const again = !e.permanent && (!e.status || e.status >= 500) && tries < 4;
        if (!again) throw e;
        change(job, { label: 'Connection problem, trying again' });
        await sleep(tries * 4000);
      }
    }
    await db.items.update(job.id, { publishRequested: 0 }).catch(() => {});
    change(job, { state: 'done', pct: 100, label: 'Published' });
    toast(`Published: ${job.title || 'item'}`);
    setTimeout(() => { if (jobs.get(job.id) === job) jobs.delete(job.id); }, 5000);
    job.resolve();
  } catch (e) {
    const msg = e.message || String(e);
    await db.items.update(job.id, { publishRequested: 0 }).catch(() => {});
    change(job, { state: 'error', label: 'Failed', error: msg });
    if (!e.silent) toast(`Publishing failed: ${msg}`);
    job.reject(e);
  }
}

async function pump() {
  if (current) return;
  const job = waitingJobs.shift();
  if (!job) return;
  current = job;
  acquire();
  try { await run(job); }
  finally {
    current = null;
    paintBar();
    if (waitingJobs.length) pump(); else release();
  }
}

// Queues an item for publishing and returns at once. The promise settles when the job ends.
export function requestPublish(id, title = '') {
  const existing = jobs.get(id);
  if (existing && ACTIVE.includes(existing.state)) return existing.promise;
  const job = { id, title, state: 'queued', pct: 0, label: 'Waiting', error: '' };
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  job.promise.catch(() => {}); // nobody has to listen
  jobs.set(id, job);
  waitingJobs.push(job);
  db.items.update(id, { publishRequested: 1 }).catch(() => {}); // remembered, so it resumes after a restart
  change(job, {});
  pump();
  return job.promise;
}

/* ---------- carry on after the app was closed or the phone was offline ---------- */
async function resumePending() {
  if (!navigator.onLine || !(await db.meta.get('owner'))) return;
  const rows = await db.items.filter((x) => x.publishRequested === 1).toArray();
  for (const r of rows) {
    if (r.status === 'published') { await db.items.update(r.id, { publishRequested: 0 }); continue; }
    requestPublish(r.id, r.title);
  }
}
setTimeout(() => { resumePending().catch(() => {}); }, 2500);
window.addEventListener('online', () => setTimeout(() => { resumePending().catch(() => {}); }, 800));
