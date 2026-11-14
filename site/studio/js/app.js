// FabStudio: private, offline-first poetry workspace (Phase 1).
import { db, uid, now } from './db.js';
import * as auth from './auth.js';
import { syncNow, syncSoon, startSyncLoop, getSyncState, getBlob } from './sync.js';
import { startCapture, recoverOrphans, isRecording } from './recorder.js';
import { preview, bake } from './mixer.js';
import { h, fmtDur, fmtSize, fmtDate, extFor, toast, probeDuration, playButton } from './ui.js';
import { publishListView, itemView } from './publish.js';

const app = document.getElementById('app');
const state = { tab: 'poems', poemId: null, itemId: null, prefill: {} };
let viewToken = 0;
let editorFlush = null;
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

// Deleting keeps a small tombstone so the deletion syncs; content and audio are removed.
async function softDelete(table, id) {
  await db[table].where('id').equals(id).modify((r) => {
    r.deletedAt = now(); r.updatedAt = now(); r.dirty = 1; r.blobPending = 0; delete r.blob;
    if (table === 'poems') { r.title = ''; r.stanzas = []; }
    if (table === 'tunes') { r.title = ''; r.rightsNote = ''; }
  });
  syncSoon();
}

/* ---------- boot ---------- */
async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/studio/sw.js', { scope: '/studio/' }).catch((e) => console.warn('Service worker failed', e));
  }
  await recoverOrphans();
  if (!(await auth.ownerInfo())) return renderLogin();
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
  const tabs = [['poems', 'Poems'], ['ideas', 'Ideas'], ['tunes', 'Tunes'], ['publish', 'Publish'], ['settings', 'Settings']];
  app.replaceChildren(
    h('header', { class: 'bar' }, h('span', { class: 'brand' }, 'FabStudio'), pill),
    h('main', { id: 'view' }),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('button', { 'data-tab': k, onclick: () => goTab(k) }, l))),
  );
  if (paintPill) window.removeEventListener('sync-state', paintPill);
  paintPill = () => {
    const s = getSyncState();
    pill.textContent = syncText(s);
    pill.dataset.state = s.state;
    // Refresh list screens after a finished sync, unless the person is in the middle of something.
    if (s.state === 'idle' && s.last && s.last !== lastSeenSync) {
      lastSeenSync = s.last;
      const busy = state.poemId || state.itemId || isRecording() || document.activeElement?.matches?.('select,input,textarea');
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
  renderView();
}
const openPoem = (id) => { state.tab = 'poems'; state.poemId = id; state.itemId = null; renderView(); };
const openItem = (id, prefill = {}) => { state.tab = 'publish'; state.itemId = id; state.prefill = prefill; state.poemId = null; renderView(); };
const nav = {
  open: openItem,
  back: () => { state.itemId = null; renderView(); },
  refresh: () => renderView(),
};

async function renderView() {
  const token = ++viewToken;
  const builders = { poems: poemsView, ideas: ideasView, tunes: tunesView, publish: () => publishListView(nav), settings: settingsView };
  const view = state.poemId ? await editorView(state.poemId)
    : state.itemId ? await itemView(state.itemId, nav, state.prefill)
    : await builders[state.tab]();
  if (token !== viewToken) return;
  editorFlush = view._flush || null;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  document.getElementById('view').replaceChildren(view);
  window.scrollTo(0, 0);
}

// Save the open poem when the app is hidden or closed.
document.addEventListener('visibilitychange', () => { if (document.hidden) editorFlush?.(); });
window.addEventListener('pagehide', () => editorFlush?.());

/* ---------- shared pieces ---------- */
function recorderPanel(poemId, onDone) {
  const btn = h('button', { class: 'btn rec' }, '● Record idea');
  const time = h('span', { class: 'time' });
  let session = null;
  let tick = null;
  btn.onclick = async () => {
    if (session) {
      clearInterval(tick);
      btn.disabled = true;
      const s = session;
      session = null;
      const capId = await s.stop();
      btn.disabled = false;
      btn.textContent = '● Record idea';
      btn.classList.remove('live');
      time.textContent = '';
      syncSoon();
      onDone?.(capId);
      return;
    }
    try {
      const p = prefs();
      session = await startCapture({ poemId, deviceId: p.deviceId, raw: p.raw });
    } catch (e) {
      return toast('Microphone unavailable: ' + (e.message || e.name));
    }
    const t0 = Date.now();
    btn.textContent = '■ Stop and save';
    btn.classList.add('live');
    tick = setInterval(() => { time.textContent = fmtDur((Date.now() - t0) / 1000); }, 250);
  };
  return h('div', { class: 'recorder' }, btn, time);
}

/* ---------- Poems ---------- */
async function poemsView() {
  const rows = (await db.poems.toArray()).filter((p) => !p.deletedAt).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Poems'), h('button', { class: 'btn primary', onclick: () => openPoem(uid()) }, 'New poem')),
    rows.length
      ? h('ul', { class: 'list' }, rows.map((p) => h('li', { class: 'item', onclick: () => openPoem(p.id) },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, poemName(p)), h('div', { class: 'sub' }, `${p.stanzas?.length || 0} stanzas, edited ${fmtDate(p.updatedAt)}`)),
          h('span', { class: 'dot', 'data-pending': p.dirty ? '1' : '0', title: p.dirty ? 'Waiting to sync' : 'Synced' }))))
      : h('p', { class: 'empty' }, 'No poems yet. Tap New poem and start writing. It saves whenever you pause.'));
}

async function editorView(id) {
  const existing = await db.poems.get(id);
  let created = !!existing;
  const base = existing || { id, title: '', stanzas: [], tuneId: null, tuneVolume: 0.3, createdAt: now() };
  const tunes = (await db.tunes.toArray()).filter((t) => !t.deletedAt);

  const title = h('input', { class: 'poem-title', placeholder: 'Title', value: base.title || '', 'aria-label': 'Title' });
  const body = h('textarea', { class: 'poem-body', placeholder: 'Write here. Leave a blank line between stanzas.', 'aria-label': 'Poem text' });
  body.value = (base.stanzas || []).join('\n\n');
  const status = h('span', { class: 'status' }, existing ? 'Saved' : '');
  const tuneSel = h('select', { 'aria-label': 'Background tune' },
    h('option', { value: '' }, 'No background tune'),
    tunes.map((t) => h('option', { value: t.id }, t.title || 'Untitled tune')));
  tuneSel.value = base.tuneId || '';
  const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.round((base.tuneVolume ?? 0.3) * 100), 'aria-label': 'Tune volume' });

  let timer = null;
  const save = async () => {
    clearTimeout(timer);
    timer = null;
    const stanzas = body.value.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const t = title.value.trim();
    if (!created && !t && !stanzas.length) return;
    const current = (await db.poems.get(id)) || base;
    created = true;
    await db.poems.put({ ...current, title: t, stanzas, tuneId: tuneSel.value || null, tuneVolume: Number(vol.value) / 100, updatedAt: now(), dirty: 1 });
    status.textContent = 'Saved';
    syncSoon();
  };
  const queue = () => { status.textContent = 'Saving…'; clearTimeout(timer); timer = setTimeout(save, 800); };
  for (const el of [title, body]) { el.addEventListener('input', queue); el.addEventListener('blur', save); }
  tuneSel.addEventListener('change', queue);
  vol.addEventListener('input', queue);

  // Voice picker
  const voiceSel = h('select', { 'aria-label': 'Voice recording' });
  const fillVoices = async (pick) => {
    const caps = (await db.captures.toArray()).filter((c) => !c.deletedAt && c.status === 'done').sort(newest);
    voiceSel.replaceChildren(...(caps.length
      ? caps.map((c) => h('option', { value: c.id }, `${fmtDate(c.createdAt)}, ${fmtDur(c.duration)}${c.poemId === id ? ', this poem' : ''}`))
      : [h('option', { value: '' }, 'No recordings yet')]));
    voiceSel.value = pick || (caps.find((c) => c.poemId === id) || caps[0])?.id || '';
  };

  // Baked files for this poem
  const bakesBox = h('div', { class: 'bakes' });
  const fillBakes = async () => {
    const rows = (await db.bakes.where('poemId').equals(id).toArray()).filter((b) => !b.deletedAt).sort(newest);
    bakesBox.replaceChildren(rows.length
      ? h('ul', { class: 'list compact' }, rows.map((b) => h('li', { class: 'item' },
          playButton(() => getBlob('bakes', b)),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, `Baked ${fmtDate(b.createdAt)}`), h('div', { class: 'sub' }, `${fmtDur(b.duration)}${b.blobPending ? ', waiting to upload' : ''}`)),
          h('button', { class: 'btn small', onclick: () => { if (isRecording()) return toast('Stop the recording first.'); openItem(crypto.randomUUID(), { bakeId: b.id }); } }, 'Publish'),
          h('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Delete this baked audio?')) return; await softDelete('bakes', b.id); fillBakes(); } }, 'Delete'))))
      : h('p', { class: 'muted small' }, 'Nothing baked yet.'));
  };

  async function materials() {
    const cap = voiceSel.value ? await db.captures.get(voiceSel.value) : null;
    if (!cap) { toast('Record or pick a voice recording first.'); return null; }
    const voice = await getBlob('captures', cap);
    if (!voice) { toast('That recording is not on this device yet. Connect to download it.'); return null; }
    let tune = null;
    let tuneRow = null;
    if (tuneSel.value) {
      tuneRow = await db.tunes.get(tuneSel.value);
      tune = tuneRow ? await getBlob('tunes', tuneRow) : null;
      if (!tune) { toast('The tune is not on this device yet. Connect to download it.'); return null; }
    }
    return { cap, voice, tune, tuneRow };
  }

  const progress = h('progress', { max: 1, value: 0, hidden: true });
  let prev = null;
  const prevBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      if (prev) return prev.stop();
      const m = await materials();
      if (!m) return;
      prevBtn.textContent = 'Stop';
      try {
        prev = await preview(m.voice, m.tune, Number(vol.value) / 100, () => { prev = null; prevBtn.textContent = 'Preview'; });
      } catch (e) { prev = null; prevBtn.textContent = 'Preview'; toast('Preview failed: ' + (e.message || e)); }
    },
  }, 'Preview');

  const bakeBtn = h('button', {
    class: 'btn primary',
    onclick: async () => {
      if (isRecording()) return toast('Stop the recording first.');
      const m = await materials();
      if (!m) return;
      created = true;
      await save();
      bakeBtn.disabled = prevBtn.disabled = true;
      progress.hidden = false;
      progress.value = 0;
      toast('Baking runs in real time. Keep this screen open.');
      try {
        const out = await bake(m.voice, m.tune, Number(vol.value) / 100, (p) => { progress.value = p; });
        const bid = uid();
        const t = now();
        await db.bakes.put({
          id: bid, poemId: id, captureId: m.cap.id, tuneId: m.tuneRow?.id || null, tuneVolume: Number(vol.value) / 100,
          mime: out.mime, duration: out.duration, blob: out.blob, r2Key: `bakes/${bid}.${extFor(out.mime)}`,
          createdAt: t, updatedAt: t, dirty: 1, blobPending: 1,
        });
        toast('Baked. It uploads when you are online.');
        syncSoon();
        await fillBakes();
      } catch (e) { toast('Baking failed: ' + (e.message || e)); }
      finally { bakeBtn.disabled = prevBtn.disabled = false; progress.hidden = true; }
    },
  }, 'Bake into one file');

  const back = async () => {
    if (isRecording()) return toast('Stop the recording first.');
    prev?.stop();
    await save();
    state.poemId = null;
    renderView();
  };

  const del = async () => {
    if (!created) { state.poemId = null; return renderView(); }
    if (!confirm('Delete this poem and its baked audio? Your voice ideas are kept.')) return;
    for (const b of await db.bakes.where('poemId').equals(id).toArray()) await softDelete('bakes', b.id);
    await db.captures.where('poemId').equals(id).modify((c) => { c.poemId = null; c.updatedAt = now(); c.dirty = 1; });
    await softDelete('poems', id);
    state.poemId = null;
    renderView();
  };

  const el = h('section', { class: 'view editor' },
    h('div', { class: 'toolbar' }, h('button', { class: 'btn small', onclick: back }, '← Poems'), status),
    title, body,
    h('div', { class: 'panel' },
      h('h3', {}, 'Background tune'), tuneSel,
      h('label', { class: 'row' }, h('span', {}, 'Volume'), vol),
      tunes.length ? null : h('p', { class: 'muted small' }, 'Add tunes in the Tunes tab.')),
    h('div', { class: 'panel' },
      h('h3', {}, 'Voice'),
      recorderPanel(id, (capId) => fillVoices(capId)),
      voiceSel,
      h('div', { class: 'row' }, prevBtn, bakeBtn),
      progress, bakesBox),
    h('button', { class: 'btn danger wide', onclick: del }, 'Delete poem'));
  el._flush = save;
  await fillVoices();
  await fillBakes();
  return el;
}

/* ---------- Ideas ---------- */
async function ideasView() {
  const caps = (await db.captures.toArray()).filter((c) => !c.deletedAt && c.status === 'done').sort(newest);
  const poems = (await db.poems.toArray()).filter((p) => !p.deletedAt).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const list = caps.length
    ? h('ul', { class: 'list' }, caps.map((c) => {
        const link = h('select', {
          class: 'inline', 'aria-label': 'Linked poem',
          onchange: async () => { await db.captures.update(c.id, { poemId: link.value || null, updatedAt: now(), dirty: 1 }); syncSoon(); },
        }, h('option', { value: '' }, 'Not linked to a poem'), poems.map((p) => h('option', { value: p.id }, poemName(p))));
        link.value = c.poemId || '';
        const where = c.blob ? fmtSize(c.blob.size) : 'in the cloud';
        return h('li', { class: 'item col' },
          h('div', { class: 'row' },
            playButton(() => getBlob('captures', c)),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, fmtDate(c.createdAt)), h('div', { class: 'sub' }, `${fmtDur(c.duration)}, ${where}${c.blobPending ? ', waiting to upload' : ''}`)),
            h('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Delete this recording?')) return; await softDelete('captures', c.id); renderView(); } }, 'Delete')),
          link);
      }))
    : h('p', { class: 'empty' }, 'No ideas yet. Tap Record the moment a line comes to you.');
  return h('section', { class: 'view' }, h('div', { class: 'toolbar' }, h('h2', {}, 'Ideas')), recorderPanel(null, () => renderView()), list);
}

/* ---------- Tunes ---------- */
async function addTune(file) {
  if (file.size > 60 * 1048576) return toast(`${file.name} is over 60 MB.`);
  const id = uid();
  const t = now();
  const mime = file.type || 'audio/mpeg';
  const duration = await probeDuration(file);
  await db.tunes.put({
    id, title: file.name.replace(/\.[^.]+$/, ''), mime, duration, rightsNote: '', blob: file,
    r2Key: `tunes/${id}.${extFor(mime, file.name)}`, createdAt: t, updatedAt: t, dirty: 1, blobPending: 1,
  });
  syncSoon();
}

async function tunesView() {
  const rows = (await db.tunes.toArray()).filter((t) => !t.deletedAt).sort(newest);
  const input = h('input', {
    type: 'file', accept: 'audio/*', multiple: true, hidden: true,
    onchange: async () => { for (const f of input.files) await addTune(f); input.value = ''; renderView(); },
  });
  const edit = (id, patch) => db.tunes.update(id, { ...patch, updatedAt: now(), dirty: 1 }).then(() => syncSoon());
  return h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Tunes'), h('button', { class: 'btn primary', onclick: () => input.click() }, 'Add tunes'), input),
    h('p', { class: 'muted small' }, 'Upload a tune once and reuse it in any poem. Only add music you have the rights to use.'),
    rows.length
      ? h('ul', { class: 'list' }, rows.map((t) => {
          const name = h('input', { class: 'inline', value: t.title || '', 'aria-label': 'Tune name', onchange: () => edit(t.id, { title: name.value.trim() }) });
          const rights = h('input', { class: 'inline', value: t.rightsNote || '', placeholder: 'Rights note: who owns it, licence', 'aria-label': 'Rights note', onchange: () => edit(t.id, { rightsNote: rights.value.trim() }) });
          return h('li', { class: 'item col' },
            h('div', { class: 'row' }, playButton(() => getBlob('tunes', t)), h('div', { class: 'grow' }, name, h('div', { class: 'sub' }, `${fmtDur(t.duration)}, ${t.blob ? fmtSize(t.blob.size) : 'in the cloud'}${t.blobPending ? ', waiting to upload' : ''}`)),
              h('button', { class: 'btn small danger', onclick: async () => { if (!confirm('Delete this tune? Poems using it will have no tune.')) return; await softDelete('tunes', t.id); renderView(); } }, 'Delete')),
            rights);
        }))
      : h('p', { class: 'empty' }, 'No tunes yet. Tap Add tunes and pick audio files from your phone.'));
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
    h('div', { class: 'panel' }, h('h3', {}, 'Account'), h('p', {}, owner?.email || ''),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('Sign out? Anything not yet synced stays on this device until you sign in again.')) return;
        await auth.signOut();
        renderLogin();
      } }, 'Sign out')),
    h('div', { class: 'panel' }, h('h3', {}, 'Sync'),
      h('p', {}, syncText(s)),
      s.last ? h('p', { class: 'muted small' }, 'Last synced ' + fmtDate(s.last)) : null,
      s.error ? h('p', { class: 'error' }, 'Last error: ' + s.error) : null,
      h('button', { class: 'btn', onclick: () => { toast('Syncing…'); syncNow(); } }, 'Sync now')),
    h('div', { class: 'panel' }, h('h3', {}, 'Storage on this device'),
      est ? h('p', {}, `${fmtSize(est.usage || 0)} used of ${fmtSize(est.quota || 0)}`) : h('p', { class: 'muted' }, 'Not available in this browser.'),
      h('progress', { max: 100, value: pct }),
      h('p', { class: 'muted small' }, persisted ? 'Protected: the browser will not clear your data to save space.' : 'Not protected yet. Installing the app to your home screen helps.'),
      persisted ? null : h('button', { class: 'btn', onclick: async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? 'Storage is now protected.' : 'The browser declined. Try installing the app first.'); renderView(); } }, 'Protect my data'),
      h('button', { class: 'btn', onclick: async () => { if (confirm('Remove local copies of audio that is safely in the cloud? Tunes used by poems stay.')) { await freeSpace(); renderView(); } } }, 'Free up space')),
    h('div', { class: 'panel' }, h('h3', {}, 'Recording'),
      mic,
      h('label', { class: 'row check' }, raw, h('span', {}, 'Raw audio (turn off voice processing). Use with your soundcard or music.')),
      h('p', { class: 'muted small' }, 'Microphone names appear after you have recorded once and allowed access.')),
    h('p', { class: 'muted small foot' }, 'FabStudio Phase 1'));
}

boot();
