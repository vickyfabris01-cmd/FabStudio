// What the console is working with: the MODE (Poem or Music) and what was picked in each. Nothing is picked when
// the app starts, so nothing is loaded until you choose it. The control in the console header has two parts:
// a Poem | Music dropdown (the mode), and a name area that says "Click to choose…" and, once something is
// picked, shows its name. The name area is itself a dropdown: it opens a list over the screen, with search.
// Picking a poem only shows its text (nothing playing is touched). Picking a music file starts it, crossfading over
// whatever is playing.
import { db } from '../db.js';
import { h, toast, fmtDur, probeDuration } from '../ui.js';
import { deck } from './deck.js';
import { folderSupported, listFolders, addFolder, removeFolder, folderAllowed, listAudio, fileKey } from './myaudio.js';
import { playlist } from './playlist.js';

export const poemName = (p) => (p.title || '').trim() || (p.stanzas?.[0] || '').split('\n')[0] || 'Untitled';

class Source extends EventTarget {
  constructor() {
    super();
    this.mode = 'poem';    // 'poem' | 'music': the first source of truth
    this.poemId = '';      // picked poem ('' = none)
    this.music = null;     // picked file: { path, name, handle, folderId, key } or null (key is what the Deck uses)
  }
  emit() { this.dispatchEvent(new Event('change')); }
  on(fn) { this.addEventListener('change', fn); return () => this.removeEventListener('change', fn); }
  setMode(m) { if (m !== this.mode) { this.mode = m; this.emit(); } }
  setPoem(id) { this.poemId = id || ''; this.emit(); }
  setMusic(m) { this.music = m || null; this.emit(); }
}
export const source = new Source();
// When loop, next or previous moves to another track, the header follows it.
playlist.onTrack((t) => source.setMusic({ path: t.path, name: t.name, handle: t.handle, folderId: t.folderId, key: t.key }));

export function sourceControl() {
  const st = { open: false, q: '', poems: [], files: [], dur: new Map(), music: 'loading', folders: [], folder: null, perm: new Map(), tuneFor: '', tune: '' };

  const mode = h('select', { class: 'src-mode', 'aria-label': 'Poem or music' }, h('option', { value: 'poem' }, 'Poem'), h('option', { value: 'music' }, 'Music'));
  const main = h('span', { class: 'src-main' });
  const sub = h('span', { class: 'src-sub' });
  const name = h('button', { class: 'src-name', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, main, sub, h('span', { class: 'src-caret', 'aria-hidden': 'true' }, '▾'));
  const search = h('input', { class: 'ma-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search' });
  const list = h('div', { class: 'src-list', role: 'listbox' });
  // Music only: which saved folder you are looking at, and adding or removing folders. Looking at another folder
  // does not change what loops; only picking a track from it does.
  const folderSel = h('select', { class: 'src-folder', 'aria-label': 'Folder' });
  const addBtn = h('button', { class: 'btn small', type: 'button' }, 'Add folder');
  const rmBtn = h('button', { class: 'btn small', type: 'button' }, 'Remove');
  const folderBar = h('div', { class: 'src-folders', hidden: true }, folderSel, addBtn, rmBtn);
  const pop = h('div', { class: 'src-pop', hidden: true }, folderBar, search, list);
  const el = h('div', { class: 'src' }, mode, name, pop);

  /* ----- the lists ----- */
  let shown = [];   // what the list shows now, so Enter can pick the first one
  const row = (label, { on, extra, onclick }) => h('button', { class: 'ma-row' + (on ? ' on' : ''), type: 'button', role: 'option', 'aria-selected': on ? 'true' : 'false', onclick },
    h('span', { class: 'grow ma-name' }, label), extra ? h('span', { class: 'muted small' }, extra) : null);

  function drawPoems() {
    const q = st.q;
    shown = st.poems.filter((p) => !q || poemName(p).toLowerCase().includes(q)).map((p) => ({ label: poemName(p), on: p.id === source.poemId, pick: () => pickPoem(p.id) }));
    list.replaceChildren(...(shown.length ? shown.map((r) => row(r.label, { on: r.on, onclick: r.pick })) : [h('p', { class: 'muted small' }, st.poems.length ? 'No poem matches.' : 'No poems yet.')]));
  }

  function drawMusic() {
    const m = st.music;
    folderBar.hidden = m === 'unsupported' || m === 'loading';
    search.hidden = m !== 'ready';
    shown = [];
    if (m === 'loading') return list.replaceChildren(h('p', { class: 'muted small' }, 'Looking at your folders…'));
    if (m === 'unsupported') return list.replaceChildren(h('p', { class: 'muted' }, 'Choosing a folder needs Chrome or Edge on a laptop.'));
    // the folder chooser: every saved folder, with the ones that need permission marked
    folderSel.replaceChildren(...st.folders.map((f) => h('option', { value: f.id, selected: f.id === st.folder?.id }, f.name + (st.perm.get(f.id) === false ? ' (needs Allow)' : ''))));
    folderSel.hidden = !st.folders.length;
    rmBtn.hidden = !st.folders.length;
    if (m === 'none') return list.replaceChildren(h('p', { class: 'muted' }, 'No audio folder yet. Files stay where they are and are never copied.'),
      h('button', { class: 'btn', type: 'button', onclick: addAFolder }, 'Choose folder'));
    if (m === 'allow') return list.replaceChildren(h('p', { class: 'muted' }, `The browser needs your permission to read ${st.folder?.name || 'the folder'} again. Once after each restart, for each folder.`),
      h('button', { class: 'btn primary', type: 'button', onclick: () => loadMusic(true) }, 'Allow'));
    const q = st.q;
    shown = st.files.filter((f) => !q || f.path.toLowerCase().includes(q)).map((f) => {
      const k = fileKey(st.folder.id, f.path);
      return { label: f.name, on: source.music?.key === k, extra: st.dur.get(k) ? fmtDur(st.dur.get(k)) : '', pick: () => pickMusic(f) };
    });
    list.replaceChildren(...(shown.length ? shown.map((r) => row(r.label, { on: r.on, extra: r.extra, onclick: r.pick })) : [h('p', { class: 'muted small' }, st.files.length ? 'No file matches.' : 'No audio files in this folder.')]));
  }

  const draw = () => (source.mode === 'poem' ? drawPoems() : drawMusic());

  async function loadPoems() {
    try { st.poems = (await db.poems.toArray()).filter((p) => !p.deletedAt).sort((a, b) => poemName(a).localeCompare(poemName(b))); } catch { st.poems = []; }
    if (st.open && source.mode === 'poem') drawPoems();
  }

  async function loadMusic(ask = false) {
    st.music = 'loading'; if (st.open && source.mode === 'music') drawMusic();
    if (!folderSupported()) st.music = 'unsupported';
    else {
      st.folders = await listFolders();
      // the folder being looked at: the one chosen last, else the one the loop is in, else the first
      st.folder = st.folders.find((f) => f.id === st.folder?.id) || st.folders.find((f) => f.id === playlist.ctx?.folderId) || st.folders[0] || null;
      st.perm = new Map();
      for (const f of st.folders) st.perm.set(f.id, await folderAllowed(f.handle));   // asks nothing: only checks
      if (!st.folder) st.music = 'none';
      else if (!(await folderAllowed(st.folder.handle, ask))) st.music = 'allow';
      else { st.perm.set(st.folder.id, true); try { st.files = await listAudio(st.folder.handle); st.music = 'ready'; } catch { st.music = 'allow'; } }
    }
    if (st.open && source.mode === 'music') drawMusic();
    if (st.music === 'ready') probeAll();
  }

  async function addAFolder() {
    try { const f = await addFolder(); st.folder = f; await loadMusic(true); } catch { /* cancelled */ }
  }
  addBtn.onclick = addAFolder;
  rmBtn.onclick = async () => {
    if (!st.folder) return;
    if (!window.confirm(`Remove "${st.folder.name}" from this list? The files are not touched.`)) return;
    await removeFolder(st.folder.id); st.folder = null; loadMusic();
  };
  folderSel.onchange = () => { st.folder = st.folders.find((f) => f.id === folderSel.value) || null; st.q = ''; search.value = ''; loadMusic(); };

  // Lengths are read from the files themselves, one after another, while the list is open.
  async function probeAll() {
    const folder = st.folder;
    for (const f of st.files.slice(0, 200)) {
      if (!st.open || st.music !== 'ready' || st.folder !== folder) return;
      const k = fileKey(folder.id, f.path);
      if (st.dur.has(k)) continue;
      try { st.dur.set(k, await probeDuration(await f.handle.getFile())); } catch { st.dur.set(k, 0); }
      if (st.open && source.mode === 'music') drawMusic();
    }
  }

  /* ----- picking: loads only, never starts ----- */
  function pickPoem(id) { source.setPoem(id); close(); }
  async function pickMusic(f) {
    try {
      const folder = st.folder;
      const key = fileKey(folder.id, f.path);
      const file = await f.handle.getFile();
      await deck.play(file, { source: 'file', key, name: f.name });   // picking music starts it; over something playing it crossfades
      source.setMusic({ path: f.path, name: f.name, handle: f.handle, folderId: folder.id, key });
      playlist.set(folder.id, st.files, f.path);   // the loop now stays inside this folder
      close();
    } catch { toast('That file could not be opened. It may have been moved.'); loadMusic(); }
  }

  /* ----- open and close ----- */
  const onDocDown = (e) => { if (!el.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); name.focus(); } };
  function openPop() {
    st.open = true; st.q = ''; search.value = '';
    pop.hidden = false; name.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey);
    if (source.mode === 'poem') { search.hidden = false; loadPoems(); drawPoems(); } else loadMusic();
    if (!search.hidden) search.focus();
  }
  function close() {
    if (!st.open) return;
    st.open = false; pop.hidden = true; name.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey);
  }
  name.onclick = () => (st.open ? close() : openPop());
  search.oninput = () => { st.q = search.value.trim().toLowerCase(); draw(); };
  search.onkeydown = (e) => { if (e.key === 'Enter' && shown[0]) shown[0].pick(); };
  mode.onchange = () => { source.setMode(mode.value); if (st.open) { st.q = ''; search.value = ''; if (source.mode === 'poem') { search.hidden = false; loadPoems(); drawPoems(); } else loadMusic(); } };

  /* ----- the name area ----- */
  // The picked poem's tune title, looked up once per poem.
  async function tuneTitle(poem) {
    if (!poem?.tuneId) return '';
    try { const t = await db.tunes.get(poem.tuneId); return t && !t.deletedAt ? (t.title || 'Tune') : ''; } catch { return ''; }
  }

  async function paint() {
    if (mode.value !== source.mode) mode.value = source.mode;
    let label = ''; let extra = '';
    if (source.mode === 'poem') {
      const poem = source.poemId ? (st.poems.find((p) => p.id === source.poemId) || (await db.poems.get(source.poemId)) || null) : null;
      label = poem && !poem.deletedAt ? poemName(poem) : '';
      if (label && st.tuneFor !== poem.id) { st.tuneFor = poem.id; st.tune = await tuneTitle(poem); }
      extra = label && st.tune ? `♪ ${st.tune}` : '';
      if (!label) st.tuneFor = '';
    } else label = source.music?.name || '';
    main.textContent = label || (source.mode === 'poem' ? 'Click to choose a poem' : 'Click to choose music');
    main.classList.toggle('unset', !label);
    sub.textContent = extra;
    name.title = label ? `${label}${extra ? ' · ' + extra : ''}` : '';
    if (st.open && source.mode === 'poem') drawPoems();
    if (st.open && source.mode === 'music') drawMusic();
  }

  const off = source.on(paint);
  loadPoems();
  paint();
  return { el, paint, dispose() { off(); close(); } };
}
