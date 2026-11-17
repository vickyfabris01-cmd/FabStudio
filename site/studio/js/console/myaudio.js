// My audio: files from a folder on this laptop, played by the Deck. The folder is chosen once (in Settings, or
// here), the browser keeps the handle, and files are read in place: they are never copied, moved or uploaded.
// After the browser restarts it asks permission again: that is the one "Allow" tap.
import { db } from '../db.js';
import { h, fmtDur, toast, probeDuration } from '../ui.js';
import { deck } from './deck.js';

const EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|webm)$/i;

export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;
export async function getFolder() { try { return (await db.meta.get('audioFolder'))?.handle || null; } catch { return null; } }
export async function forgetFolder() { await db.meta.delete('audioFolder'); }

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'fabstudio-audio', mode: 'read' });
  await db.meta.put({ key: 'audioFolder', handle });
  return handle;
}

// true when reading is allowed. With ask = true it shows the browser's prompt (must come from a tap).
export async function folderAllowed(handle, ask = false) {
  if (!handle?.queryPermission) return false;
  const opts = { mode: 'read' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (ask) return (await handle.requestPermission(opts)) === 'granted';
  } catch { /* not allowed */ }
  return false;
}

// Audio files in the folder and one level of sub-folders, sorted by name.
export async function listAudio(handle) {
  const out = [];
  const walk = async (dir, prefix, depth) => {
    for await (const [name, entry] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (entry.kind === 'file' && EXT.test(name)) out.push({ path: prefix + name, name: name.replace(/\.[^.]+$/, ''), handle: entry });
      else if (entry.kind === 'directory' && depth < 1) await walk(entry, `${prefix}${name}/`, depth + 1);
    }
  };
  await walk(handle, '', 0);
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
}

// The "My audio" tab. Returns { el, paint, dispose }. paint() follows the Deck.
export function myAudioPane() {
  const st = { handle: null, files: [], dur: new Map(), q: '', state: 'loading', dead: false };
  const body = h('div', { class: 'ma-body' });
  const search = h('input', { class: 'ma-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search my audio' });
  search.oninput = () => { st.q = search.value.trim().toLowerCase(); drawRows(); };
  const rows = h('div', { class: 'ma-rows' });
  const head = h('div', { class: 'ma-head small muted' });
  const seek = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Position' });
  seek.oninput = () => { if (deck.audio && deck.s.source === 'file') deck.seek(Number(seek.value)); };
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: deck.s.volume, 'aria-label': 'Volume' });
  vol.oninput = () => deck.setVolume(Number(vol.value));
  const mini = h('div', { class: 'ma-mini', hidden: true },
    h('div', { class: 'row small' }, h('b', { class: 'grow ma-now' }), h('span', { class: 'muted ma-time' })),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, seek), h('span', { class: 'small muted' }, 'Vol'), h('div', { style: 'width:90px' }, vol)));
  const el = h('div', { class: 'ma' }, body, mini);

  async function load(ask = false) {
    st.state = 'loading'; draw();
    if (!folderSupported()) { st.state = 'unsupported'; return draw(); }
    st.handle = await getFolder();
    if (!st.handle) { st.state = 'none'; return draw(); }
    if (!(await folderAllowed(st.handle, ask))) { st.state = 'allow'; return draw(); }
    try { st.files = await listAudio(st.handle); st.state = 'ready'; }
    catch { st.state = 'allow'; }
    draw();
    probeAll();
  }

  // Lengths are read from the files themselves, one after another, in the background.
  async function probeAll() {
    for (const f of st.files.slice(0, 200)) {
      if (st.dead || st.state !== 'ready') return;
      if (st.dur.has(f.path)) continue;
      try { st.dur.set(f.path, await probeDuration(await f.handle.getFile())); } catch { st.dur.set(f.path, 0); }
      drawRows();
    }
  }

  async function toggle(f) {
    if (deck.isPlaying(f.path)) return deck.pause();
    if (deck.isLoaded(f.path)) return deck.resume();
    try {
      const file = await f.handle.getFile();
      await deck.play(file, { source: 'file', key: f.path, name: f.name });
    } catch { toast('That file could not be opened. It may have been moved.'); load(); }
  }

  function drawRows() {
    const list = st.files.filter((f) => !st.q || f.path.toLowerCase().includes(st.q));
    rows.replaceChildren(...(list.length ? list.map((f) => {
      const on = deck.isLoaded(f.path);
      const d = st.dur.get(f.path);
      return h('button', { class: 'ma-row' + (on ? ' on' : ''), type: 'button', onclick: () => toggle(f) },
        h('span', { class: 'ma-ic', 'aria-hidden': 'true' }, deck.isPlaying(f.path) ? '❚❚' : '▶'),
        h('span', { class: 'grow ma-name' }, f.name), h('span', { class: 'muted small' }, d ? fmtDur(d) : ''));
    }) : [h('p', { class: 'muted small' }, st.files.length ? 'No file matches.' : 'No audio files in this folder.')]));
  }

  function draw() {
    const s = st.state;
    if (s === 'loading') return body.replaceChildren(h('p', { class: 'muted small' }, 'Looking at your folder…'));
    if (s === 'unsupported') return body.replaceChildren(h('p', { class: 'muted' }, 'Choosing a folder needs Chrome or Edge on a laptop.'));
    if (s === 'none') return body.replaceChildren(h('p', { class: 'muted' }, 'No audio folder yet. Files stay where they are and are never copied.'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { try { await pickFolder(); load(); } catch { /* cancelled */ } } }, 'Choose folder'));
    if (s === 'allow') return body.replaceChildren(h('p', { class: 'muted' }, `The browser needs your permission to read ${st.handle?.name || 'the folder'} again. Once after each restart.`),
      h('button', { class: 'btn primary', type: 'button', onclick: () => load(true) }, 'Allow'));
    head.textContent = `${st.handle.name} · ${st.files.length} file${st.files.length === 1 ? '' : 's'}`;
    body.replaceChildren(head, search, rows);
    drawRows();
  }

  let lastKey = '';
  function paint() {
    const d = deck.s;
    const key = `${d.key}|${d.playing}`;
    if (key !== lastKey) { lastKey = key; if (st.state === 'ready') drawRows(); }
    const mine = d.source === 'file';
    mini.hidden = !mine;
    if (mine) {
      mini.querySelector('.ma-now').textContent = d.name;
      mini.querySelector('.ma-time').textContent = `${fmtDur(d.time)} / ${fmtDur(d.duration)}`;
      seek.max = d.duration || 1;
      if (document.activeElement !== seek) seek.value = d.time;
    }
    if (document.activeElement !== vol) vol.value = d.volume;
  }

  load();
  return { el, paint, dispose() { st.dead = true; } };
}
