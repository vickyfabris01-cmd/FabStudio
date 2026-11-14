// FabStudio: private, offline-first poetry workspace.
// Tabs: Studio (bake, upload, publish), Poems (write, record, background tune), Settings.
import { db, uid, now } from './db.js';
import * as auth from './auth.js';
import { syncNow, syncSoon, startSyncLoop, getSyncState, getBlob } from './sync.js';
import { startCapture, recoverOrphans, isRecording } from './recorder.js';
import { h, fmtDur, fmtSize, fmtDate, extFor, toast, probeDuration, playButton, fileChip, popMenu, openModal, micIcon, dotsIcon, stopIcon, tabIcon } from './ui.js';
import { publishListView, itemView } from './publish.js';
import { bakerView, openBakeModal } from './baker.js';

const app = document.getElementById('app');
const state = { tab: 'poems', poemId: null, itemId: null, prefill: {}, bake: null };
let viewToken = 0;
let editorFlush = null;
let disposeView = null;
let paintPill = null;
let lastSeenSync = null;

const prefs = () => {
  try { return { deviceId: '', raw: false, ...JSON.parse(localStorage.getItem('fabstudio.prefs') || '{}') }; }
  catch { return { deviceId: '', raw: false }; }
};
const setPrefs = (p) => localStorage.setItem('fabstudio.prefs', JSON.stringify({ ...prefs(), ...p }));
const newest = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
const firstLine = (p) => (p.stanzas?.[0] || '').split('\n')[0];
const poemName = (p) => p.title || firstLine(p) || 'Untitled';
const recordingName = (iso) => `Recording ${fmtDate(iso)}`;

// Deleting keeps a small tombstone so the deletion syncs; content and audio are removed.
async function softDelete(table, id) {
  await db[table].where('id').equals(id).modify((r) => {
    r.deletedAt = now(); r.updatedAt = now(); r.dirty = 1; r.blobPending = 0; delete r.blob;
    if (table === 'poems') { r.title = ''; r.stanzas = []; }
    if (table === 'tunes') { r.title = ''; r.rightsNote = ''; }
  });
  syncSoon();
}

// A poem goes with its recordings and baked audio. Items already in Studio stay.
async function deletePoem(id) {
  for (const b of await db.bakes.where('poemId').equals(id).toArray()) if (!b.deletedAt) await softDelete('bakes', b.id);
  for (const c of await db.captures.where('poemId').equals(id).toArray()) if (!c.deletedAt) await softDelete('captures', c.id);
  await softDelete('poems', id);
}

// Recordings made before this layout (the old Ideas tab) get a poem each, so they are still reachable.
async function migrateLooseRecordings() {
  const loose = (await db.captures.toArray()).filter((c) => !c.deletedAt && c.status === 'done' && !c.poemId);
  for (const c of loose) {
    const pid = uid();
    const t = now();
    await db.poems.put({ id: pid, title: recordingName(c.createdAt), stanzas: [], tuneId: null, tuneVolume: 0.5, createdAt: c.createdAt, updatedAt: t, dirty: 1 });
    await db.captures.update(c.id, { poemId: pid, updatedAt: t, dirty: 1 });
  }
  if (loose.length) syncSoon();
}

/* ---------- boot ---------- */
async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/studio/sw.js', { scope: '/studio/' }).catch((e) => console.warn('Service worker failed', e));
  }
  await recoverOrphans();
  if (!(await auth.ownerInfo())) return renderLogin();
  await migrateLooseRecordings();
  renderShell();
  startSyncLoop();
}

function renderLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', placeholder: 'Email', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', required: true });
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', {
    class: 'login',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!navigator.onLine) { err.textContent = 'The first sign-in needs internet.'; return; }
      btn.disabled = true;
      try { await auth.signIn(email.value.trim(), pw.value); await boot(); }
      catch (x) { err.textContent = x.message || 'Sign-in failed.'; btn.disabled = false; }
    },
  }, h('h1', {}, 'FabStudio'), h('p', { class: 'muted' }, 'Owner sign-in. After the first time, the app opens without internet.'), email, pw, err, btn);
  app.replaceChildren(h('div', { class: 'login-wrap' }, form));
}

function syncText(s) {
  const waiting = s.pending ? `, ${s.pending} waiting` : '';
  return { idle: s.pending ? `${s.pending} waiting` : 'Synced', syncing: 'Syncing…', offline: 'Offline' + waiting, auth: 'Sign in to sync', error: 'Sync problem' + waiting }[s.state] || '';
}

function renderShell() {
  const pill = h('button', { class: 'pill', onclick: () => goTab('settings') });
  const tabs = [['studio', 'Studio'], ['poems', 'Poems'], ['settings', 'Settings']];
  app.replaceChildren(
    h('header', { class: 'bar' }, h('span', { class: 'brand' }, 'FabStudio'), pill),
    h('main', { id: 'view' }),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { 'data-tab': k, 'aria-label': l, onclick: () => goTab(k) }, tabIcon(k), h('span', {}, l)))),
  );
  if (paintPill) window.removeEventListener('sync-state', paintPill);
  paintPill = () => {
    const s = getSyncState();
    pill.textContent = syncText(s);
    pill.dataset.state = s.state;
    // Refresh list screens after a finished sync, unless the person is in the middle of something.
    if (s.state === 'idle' && s.last && s.last !== lastSeenSync) {
      lastSeenSync = s.last;
      const busy = state.poemId || state.itemId || state.bake || isRecording() || document.querySelector('.modal-back') || document.activeElement?.matches?.('select,input,textarea');
      if (!busy) renderView();
    }
  };
  window.addEventListener('sync-state', paintPill);
  paintPill();
  renderView();
}

function goTab(k) {
  if (isRecording()) return toast('Stop the recording first.');
  state.tab = k;
  state.poemId = null;
  state.itemId = null;
  state.bake = null;
  renderView();
}
const openPoem = (id) => { state.tab = 'poems'; state.poemId = id; state.itemId = null; state.bake = null; renderView(); };
const openItem = (id, prefill = {}) => { state.tab = 'studio'; state.itemId = id; state.prefill = prefill; state.poemId = null; state.bake = null; renderView(); };
const nav = {
  open: openItem,
  back: () => { state.itemId = null; state.bake = null; renderView(); },
  refresh: () => renderView(),
  bake: () => { state.tab = 'studio'; state.itemId = null; state.poemId = null; state.bake = { poemId: null }; renderView(); },
  pickBake: (id) => { state.bake = { poemId: id }; renderView(); },
};

async function renderView() {
  const token = ++viewToken;
  const builders = { poems: poemsView, studio: () => publishListView(nav), settings: settingsView };
  const view = state.poemId ? await editorView(state.poemId)
    : state.bake ? await bakerView({ poemId: state.bake.poemId, nav })
    : state.itemId ? await itemView(state.itemId, nav, state.prefill)
    : await (builders[state.tab] || poemsView)();
  if (token !== viewToken) { view._dispose?.(); return; }
  try { disposeView?.(); } catch { /* ignore */ }
  disposeView = view._dispose || null;
  editorFlush = view._flush || null;
  document.body.classList.toggle('baking', !!state.bake?.poemId);
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  document.getElementById('view').replaceChildren(view);
  window.scrollTo(0, 0);
}

// Save the open poem when the app is hidden or closed.
document.addEventListener('visibilitychange', () => { if (document.hidden) editorFlush?.(); });
window.addEventListener('pagehide', () => editorFlush?.());

/* ---------- shared pieces ---------- */
// The round record button. It records into the poem that getPoemId() names, then calls onDone(captureId, poemId).
function recFab(getPoemId, onDone) {
  const btn = h('button', { class: 'fab rec', type: 'button', 'aria-label': 'Record' });
  const idle = () => { btn.classList.remove('live'); btn.replaceChildren(micIcon()); };
  idle();
  let session = null;
  let tick = null;
  let pid = null;
  btn.onclick = async () => {
    if (session) {
      clearInterval(tick);
      btn.disabled = true;
      const s = session;
      session = null;
      try {
        const capId = await s.stop();
        syncSoon();
        await onDone(capId, pid);
      } catch (e) { toast('Could not save the recording: ' + (e.message || e)); }
      btn.disabled = false;
      idle();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) return toast('Recording is not available in this browser.');
    pid = getPoemId();
    try {
      const p = prefs();
      session = await startCapture({ poemId: pid, deviceId: p.deviceId, raw: p.raw });
    } catch (e) {
      return toast('Microphone unavailable: ' + (e.message || e.name));
    }
    const t0 = Date.now();
    const label = h('span', { class: 'fab-t' }, '0:00');
    btn.classList.add('live');
    btn.replaceChildren(stopIcon(), label);
    tick = setInterval(() => { label.textContent = fmtDur((Date.now() - t0) / 1000); }, 250);
  };
  return btn;
}

async function addTune(file) {
  if (file.size > 60 * 1048576) { toast(`${file.name} is over 60 MB.`); return null; }
  const id = uid();
  const t = now();
  const mime = file.type || 'audio/mpeg';
  const duration = await probeDuration(file);
  await db.tunes.put({
    id, title: file.name.replace(/\.[^.]+$/, ''), mime, duration, rightsNote: '', blob: file,
    r2Key: `tunes/${id}.${extFor(mime, file.name)}`, createdAt: t, updatedAt: t, dirty: 1, blobPending: 1,
  });
  syncSoon();
  return id;
}

/* ---------- Poems ---------- */
async function poemsView() {
  const rows = (await db.poems.toArray()).filter((p) => !p.deletedAt).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const fab = recFab(() => uid(), async (capId, pid) => {
    const cap = await db.captures.get(capId);
    if (!cap) return toast('Nothing was recorded.');
    const t = now();
    await db.poems.put({ id: pid, title: recordingName(cap.createdAt), stanzas: [], tuneId: null, tuneVolume: 0.5, createdAt: t, updatedAt: t, dirty: 1 });
    syncSoon();
    toast('Saved in a new poem.');
    renderView();
  });
  return h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Poems'), h('button', { class: 'btn primary', onclick: () => openPoem(uid()) }, 'New poem')),
    rows.length
      ? h('ul', { class: 'list' }, rows.map((p) => {
          const more = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Poem actions' }, dotsIcon());
          more.onclick = (e) => {
            e.stopPropagation();
            popMenu(more, [
              { label: 'Open', onclick: () => openPoem(p.id) },
              { label: 'Delete poem', danger: true, onclick: async () => {
                if (isRecording()) return toast('Stop the recording first.');
                if (!confirm('Delete this poem with its recordings and baked audio?')) return;
                await deletePoem(p.id);
                renderView();
              } },
            ]);
          };
          return h('li', { class: 'item', onclick: () => openPoem(p.id) },
            h('div', { class: 'grow' }, h('div', { class: 'title' }, poemName(p)), h('div', { class: 'sub' }, `${p.stanzas?.length || 0} stanzas, edited ${fmtDate(p.updatedAt)}`)),
            h('span', { class: 'dot', 'data-pending': p.dirty ? '1' : '0', title: p.dirty ? 'Waiting to sync' : 'Synced' }),
            h('span', { class: 'menuwrap' }, more));
        }))
      : h('p', { class: 'empty' }, 'No poems yet. Tap New poem and start writing, or tap the red button and speak. It saves whenever you pause.'),
    fab);
}

async function editorView(id) {
  const existing = await db.poems.get(id);
  let created = !!existing;
  const base = existing || { id, title: '', stanzas: [], tuneId: null, tuneVolume: 0.5, createdAt: now() };
  let tuneId = base.tuneId || null;

  const title = h('input', { class: 'poem-title', placeholder: 'Title', value: base.title || '', 'aria-label': 'Title' });
  const body = h('textarea', { class: 'poem-body', placeholder: 'Write here. Leave a blank line between stanzas.', 'aria-label': 'Poem text' });
  body.value = (base.stanzas || []).join('\n\n');
  const status = h('span', { class: 'status' }, existing ? 'Saved' : '');
  const filesBox = h('div', { class: 'files' });

  // The page grows with the text, and a blank area below it always keeps the page scrollable.
  const grow = () => { body.style.height = 'auto'; body.style.height = body.scrollHeight + 'px'; };

  let timer = null;
  const save = async () => {
    clearTimeout(timer);
    timer = null;
    const stanzas = body.value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const t = title.value.trim();
    if (!created && !t && !stanzas.length) return;
    const current = (await db.poems.get(id)) || base;
    created = true;
    await db.poems.put({ ...current, title: t, stanzas, tuneId, tuneVolume: current.tuneVolume ?? 0.5, updatedAt: now(), dirty: 1 });
    status.textContent = 'Saved';
    syncSoon();
  };
  const queue = () => { status.textContent = 'Saving…'; clearTimeout(timer); timer = setTimeout(save, 800); };
  for (const el of [title, body]) { el.addEventListener('input', queue); el.addEventListener('blur', save); }
  body.addEventListener('input', grow);
  window.addEventListener('resize', grow);
  setTimeout(grow, 60);

  /* files of this poem, shown under the title */
  const fillFiles = async () => {
    const tune = tuneId ? await db.tunes.get(tuneId) : null;
    const caps = (await db.captures.where('poemId').equals(id).toArray()).filter((c) => !c.deletedAt && c.status === 'done').sort(newest);
    const bakes = (await db.bakes.where('poemId').equals(id).toArray()).filter((b) => !b.deletedAt).sort(newest);
    const chips = [];
    if (tune && !tune.deletedAt) chips.push(fileChip({ label: tune.title || 'Tune', sub: fmtDur(tune.duration), getBlob: () => getBlob('tunes', tune), onDelete: removeTune }));
    for (const c of caps) chips.push(fileChip({ label: 'Voice', sub: fmtDur(c.duration), getBlob: () => getBlob('captures', c), onDelete: () => removeFile('captures', c.id, 'this recording') }));
    for (const b of bakes) chips.push(fileChip({ label: title.value.trim() || poemName(base), sub: 'Baked ' + fmtDur(b.duration), onOpen: () => openBakeModal(b.id, { onChange: fillFiles }), onDelete: () => removeFile('bakes', b.id, 'this baked file') }));
    filesBox.replaceChildren(...chips);
  };
  async function removeFile(table, fid, what) {
    if (!confirm(`Delete ${what}?`)) return;
    await softDelete(table, fid);
    await fillFiles();
  }
  async function setTune(tid) {
    created = true;
    tuneId = tid;
    await save();
    await fillFiles();
  }
  async function removeTune() {
    const others = (await db.poems.toArray()).filter((p) => !p.deletedAt && p.id !== id && p.tuneId === tuneId);
    if (others.length) { if (!confirm('Other poems use this tune too. Remove it from this poem only?')) return; }
    else if (!confirm('Delete this background tune?')) return;
    const old = tuneId;
    tuneId = null;
    await save();
    if (!others.length) await softDelete('tunes', old);
    await fillFiles();
  }

  /* upload background music: pick one already uploaded, or upload a new one */
  const chooseTune = () => {
    const box = h('div', { class: 'stack' });
    const m = openModal(h('h3', {}, 'Background music'), box);
    const home = () => box.replaceChildren(
      h('button', { class: 'btn', onclick: existingList }, 'Pick existing'),
      h('button', { class: 'btn primary', onclick: uploadNew }, 'Upload new'),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'));
    const uploadNew = () => {
      const input = h('input', { type: 'file', accept: 'audio/*' });
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        const tid = await addTune(f);
        if (tid) { await setTune(tid); toast('Background music added.'); }
      };
      input.click();
      m.close();
    };
    const existingList = async () => {
      const tunes = (await db.tunes.toArray()).filter((t) => !t.deletedAt).sort(newest);
      box.replaceChildren(
        tunes.length
          ? h('ul', { class: 'list compact' }, tunes.map((t) => h('li', { class: 'item' },
              h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title || 'Untitled tune'), h('div', { class: 'sub' }, fmtDur(t.duration))),
              h('button', { class: 'btn small primary', onclick: async () => { m.close(); await setTune(t.id); toast('Background music set.'); } }, 'Use'))))
          : h('p', { class: 'muted' }, 'No music uploaded yet. Use Upload new.'),
        h('button', { class: 'btn', onclick: home }, 'Back'));
    };
    home();
  };

  /* manage files: list, play, delete; tune name and rights note */
  const manageFiles = async () => {
    const box = h('div', { class: 'stack' });
    const m = openModal(h('h3', {}, 'Files in this poem'), box, h('button', { class: 'btn', onclick: () => m.close() }, 'Close'));
    const paint = async () => {
      const tune = tuneId ? await db.tunes.get(tuneId) : null;
      const caps = (await db.captures.where('poemId').equals(id).toArray()).filter((c) => !c.deletedAt && c.status === 'done').sort(newest);
      const bakes = (await db.bakes.where('poemId').equals(id).toArray()).filter((b) => !b.deletedAt).sort(newest);
      const rows = [];
      const delBtn = (fn) => h('button', { class: 'btn small danger', onclick: async () => { await fn(); await paint(); await fillFiles(); } }, 'Delete');
      if (tune && !tune.deletedAt) {
        const edit = (patch) => db.tunes.update(tune.id, { ...patch, updatedAt: now(), dirty: 1 }).then(() => syncSoon());
        const name = h('input', { class: 'inline', value: tune.title || '', 'aria-label': 'Tune name', onchange: () => edit({ title: name.value.trim() }) });
        const rights = h('input', { class: 'inline', value: tune.rightsNote || '', placeholder: 'Rights note: who owns it, licence', 'aria-label': 'Rights note', onchange: () => edit({ rightsNote: rights.value.trim() }) });
        rows.push(h('li', { class: 'item col' },
          h('div', { class: 'row' }, playButton(() => getBlob('tunes', tune)), h('div', { class: 'grow' }, name, h('div', { class: 'sub' }, `Background tune, ${fmtDur(tune.duration)}`)), delBtn(removeTune)),
          rights));
      }
      for (const c of caps) rows.push(h('li', { class: 'item' }, playButton(() => getBlob('captures', c)),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, 'Voice recording'), h('div', { class: 'sub' }, `${fmtDur(c.duration)}, ${fmtDate(c.createdAt)}`)),
        delBtn(() => removeFile('captures', c.id, 'this recording'))));
      for (const b of bakes) rows.push(h('li', { class: 'item' }, playButton(() => getBlob('bakes', b)),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, 'Baked audio'), h('div', { class: 'sub' }, `${fmtDur(b.duration)}, ${fmtDate(b.createdAt)}`)),
        delBtn(() => removeFile('bakes', b.id, 'this baked file'))));
      box.replaceChildren(rows.length ? h('ul', { class: 'list compact' }, rows) : h('p', { class: 'muted' }, 'No files in this poem yet.'));
    };
    await paint();
  };

  const fab = recFab(() => id, async () => {
    if (!title.value.trim()) title.value = recordingName(now());
    created = true;
    await save();
    await fillFiles();
  });

  const back = async () => {
    if (isRecording()) return toast('Stop the recording first.');
    await save();
    state.poemId = null;
    renderView();
  };

  const del = async () => {
    if (isRecording()) return toast('Stop the recording first.');
    if (!created) { state.poemId = null; return renderView(); }
    if (!confirm('Delete this poem with its recordings and baked audio?')) return;
    await deletePoem(id);
    state.poemId = null;
    renderView();
  };

  const more = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Poem actions' }, dotsIcon());
  more.onclick = () => popMenu(more, [
    { label: 'Record', onclick: () => fab.click() },
    { label: 'Upload background music', onclick: chooseTune },
    { label: 'Manage files', onclick: manageFiles },
    { label: 'Copy text', onclick: async () => {
      try { await navigator.clipboard.writeText([title.value.trim(), body.value.trim()].filter(Boolean).join('\n\n')); toast('Copied.'); }
      catch { toast('Could not copy.'); }
    } },
    { label: 'Delete poem', danger: true, onclick: del },
  ]);

  const el = h('section', { class: 'view editor' },
    h('div', { class: 'toolbar' }, h('button', { class: 'btn small', onclick: back }, '← Poems'), h('span', { class: 'grow status', style: 'text-align:right' }, status), h('span', { class: 'menuwrap' }, more)),
    title, filesBox, body,
    h('div', { class: 'spacer', 'aria-hidden': 'true' }),
    fab);
  el._flush = save;
  el._dispose = () => window.removeEventListener('resize', grow);
  await fillFiles();
  return el;
}

/* ---------- Settings ---------- */
async function freeSpace() {
  const used = new Set((await db.poems.toArray()).filter((p) => !p.deletedAt && p.tuneId).map((p) => p.tuneId));
  let n = 0;
  for (const name of ['captures', 'bakes', 'tunes']) {
    await db[name].toCollection().modify((r) => {
      if (r.blob && r.r2Key && !r.dirty && !r.blobPending && !r.deletedAt && !(name === 'tunes' && used.has(r.id))) { delete r.blob; n++; }
    });
  }
  toast(`Freed ${n} file${n === 1 ? '' : 's'}. They are still in the cloud.`);
}

async function settingsView() {
  const owner = await auth.ownerInfo();
  const p = prefs();
  const s = getSyncState();
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  let devices = [];
  try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { /* none */ }

  const mic = h('select', { 'aria-label': 'Microphone', onchange: () => setPrefs({ deviceId: mic.value }) },
    h('option', { value: '' }, 'Phone default'),
    devices.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => h('option', { value: d.deviceId }, d.label || `Microphone ${i + 1}`)));
  mic.value = p.deviceId || '';
  const raw = h('input', { type: 'checkbox', checked: p.raw, onchange: () => setPrefs({ raw: raw.checked }) });

  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password' });
  const reauth = s.state === 'auth'
    ? h('div', { class: 'panel' }, h('p', {}, 'Sign in again to sync. Your writing is safe on this device.'), pw,
        h('button', { class: 'btn primary', onclick: async () => {
          try { await auth.signIn(owner.email, pw.value); syncNow(); renderView(); } catch (e) { toast(e.message || 'Sign-in failed.'); }
        } }, 'Sign in'))
    : null;

  const pct = est?.quota ? Math.min(100, Math.round((est.usage / est.quota) * 100)) : 0;
  return h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Settings')),
    reauth,
    h('div', { class: 'panel' }, h('h3', {}, 'Sync'),
      h('p', {}, syncText(s)),
      s.last ? h('p', { class: 'muted small' }, 'Last synced ' + fmtDate(s.last)) : null,
      s.error ? h('p', { class: 'error' }, 'Last error: ' + s.error) : null,
      h('button', { class: 'btn', onclick: () => { toast('Syncing…'); syncNow(); } }, 'Sync now')),
    h('div', { class: 'panel' }, h('h3', {}, 'Storage'),
      est ? h('p', {}, `This device: ${fmtSize(est.usage || 0)} used of ${fmtSize(est.quota || 0)}`) : h('p', { class: 'muted' }, 'This device: not available in this browser.'),
      h('progress', { max: 100, value: pct }),
      h('p', { class: 'muted small' }, persisted ? 'Protected: the browser will not clear your data to save space.' : 'Not protected yet. Installing the app to your home screen helps.'),
      persisted ? null : h('button', { class: 'btn', onclick: async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? 'Storage is now protected.' : 'The browser declined. Try installing the app first.'); renderView(); } }, 'Protect my data'),
      h('button', { class: 'btn', onclick: async () => { if (confirm('Remove local copies of audio that is safely in the cloud? Tunes used by poems stay.')) { await freeSpace(); renderView(); } } }, 'Free up space'),
      h('p', {}, 'Cloud (R2): not set up yet'),
      h('progress', { max: 100, value: 0 }),
      h('p', { class: 'muted small' }, 'Cloud usage will show here once it is configured.')),
    h('div', { class: 'panel' }, h('h3', {}, 'Recording'),
      mic,
      h('label', { class: 'row check' }, raw, h('span', {}, 'Raw audio (turn off voice processing). Use with your soundcard or music.')),
      h('p', { class: 'muted small' }, 'Microphone names appear after you have recorded once and allowed access.')),
    h('div', { class: 'panel' }, h('h3', {}, 'Account'), h('p', {}, owner?.email || ''),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Sign out? Anything not yet synced stays on this device until you sign in again.')) return;
        await auth.signOut();
        renderLogin();
      } }, 'Sign out')),
    h('p', { class: 'muted small foot' }, 'FabStudio'));
}

boot();
