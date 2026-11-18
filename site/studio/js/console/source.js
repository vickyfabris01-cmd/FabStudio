// What the console is working with: the MODE (Poem or Music) and what was picked in each. Nothing is picked when
// the app starts, so nothing is loaded until you choose it. The control in the console header has two parts:
// a Poem | Music dropdown (the mode), and a name area that says "Click to choose…" and, once something is
// picked, shows its name. The name area is itself a dropdown: it opens a list over the screen, with search.
// Picking only LOADS: a poem shows its text, a music file is opened in the Deck paused. Play starts it.
import { db } from '../db.js';
import { h, toast, fmtDur, probeDuration } from '../ui.js';
import { deck } from './deck.js';
import { folderSupported, getFolder, pickFolder, folderAllowed, listAudio } from './myaudio.js';

export const poemName = (p) => (p.title || '').trim() || (p.stanzas?.[0] || '').split('\n')[0] || 'Untitled';

class Source extends EventTarget {
  constructor() {
    super();
    this.mode = 'poem';    // 'poem' | 'music': the first source of truth
    this.poemId = '';      // picked poem ('' = none)
    this.music = null;     // picked file: { path, name, handle } or null
  }
  emit() { this.dispatchEvent(new Event('change')); }
  on(fn) { this.addEventListener('change', fn); return () => this.removeEventListener('change', fn); }
  setMode(m) { if (m !== this.mode) { this.mode = m; this.emit(); } }
  setPoem(id) { this.poemId = id || ''; this.emit(); }
  setMusic(m) { this.music = m || null; this.emit(); }
}
export const source = new Source();

export function sourceControl() {
  const st = { open: false, q: '', poems: [], files: [], dur: new Map(), music: 'loading', handle: null, tuneFor: '', tune: '' };

  const mode = h('select', { class: 'src-mode', 'aria-label': 'Poem or music' }, h('option', { value: 'poem' }, 'Poem'), h('option', { value: 'music' }, 'Music'));
  const main = h('span', { class: 'src-main' });
  const sub = h('span', { class: 'src-sub' });
  const name = h('button', { class: 'src-name', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, main, sub, h('span', { class: 'src-caret', 'aria-hidden': 'true' }, '▾'));
  const search = h('input', { class: 'ma-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search' });
  const list = h('div', { class: 'src-list', role: 'listbox' });
  const pop = h('div', { class: 'src-pop', hidden: true }, search, list);
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
    const s = st.music;
    search.hidden = s !== 'ready';
    shown = [];
    if (s === 'loading') return list.replaceChildren(h('p', { class: 'muted small' }, 'Looking at your folder…'));
    if (s === 'unsupported') return list.replaceChildren(h('p', { class: 'muted' }, 'Choosing a folder needs Chrome or Edge on a laptop.'));
    if (s === 'none') return list.replaceChildren(h('p', { class: 'muted' }, 'No audio folder yet. Files stay where they are and are never copied.'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { try { await pickFolder(); loadMusic(); } catch { /* cancelled */ } } }, 'Choose folder'));
    if (s === 'allow') return list.replaceChildren(h('p', { class: 'muted' }, `The browser needs your permission to read ${st.handle?.name || 'the folder'} again. Once after each restart.`),
      h('button', { class: 'btn primary', type: 'button', onclick: () => loadMusic(true) }, 'Allow'));
    const q = st.q;
    shown = st.files.filter((f) => !q || f.path.toLowerCase().includes(q)).map((f) => ({ label: f.name, on: source.music?.path === f.path, extra: st.dur.get(f.path) ? fmtDur(st.dur.get(f.path)) : '', pick: () => pickMusic(f) }));
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
      st.handle = await getFolder();
      if (!st.handle) st.music = 'none';
      else if (!(await folderAllowed(st.handle, ask))) st.music = 'allow';
      else { try { st.files = await listAudio(st.handle); st.music = 'ready'; } catch { st.music = 'allow'; } }
    }
    if (st.open && source.mode === 'music') drawMusic();
    if (st.music === 'ready') probeAll();
  }

  // Lengths are read from the files themselves, one after another, while the list is open.
  async function probeAll() {
    for (const f of st.files.slice(0, 200)) {
      if (!st.open || st.music !== 'ready') return;
      if (st.dur.has(f.path)) continue;
      try { st.dur.set(f.path, await probeDuration(await f.handle.getFile())); } catch { st.dur.set(f.path, 0); }
      if (st.open && source.mode === 'music') drawMusic();
    }
  }

  /* ----- picking: loads only, never starts ----- */
  function pickPoem(id) { source.setPoem(id); close(); }
  async function pickMusic(f) {
    try {
      const file = await f.handle.getFile();
      await deck.load(file, { source: 'file', key: f.path, name: f.name });
      source.setMusic({ path: f.path, name: f.name, handle: f.handle });
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
