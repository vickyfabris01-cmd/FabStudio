// Publishing: turn a baked poem, an audio file or a video into something the public can play.
// Drafts are made offline. Publishing runs in the background (publisher.js) and carries on when you
// leave the page. Unpublishing and deleting need internet.
import { sb } from '../../shared/supabase.js';
import { db, now } from './db.js';
import { syncSoon, syncAndWait } from './sync.js';
import { unpublishItem, deleteItemFiles, fetchMedia, deleteMedia } from './api.js';
import { requestPublish, jobFor, isBusy, onPublishJobs } from './publisher.js';
import { thumbFromImage, thumbFromTitle, thumbFromVideo } from './thumbs.js';
import { pickThumbnail } from './thumb-picker.js';
import { createSelection, selectBar, tickBox } from './select.js';
import { downloadName, extOf } from '../../shared/dl-name.js';
import { extractAudio } from './mp4-audio.js';
import { scenePanel } from './scene-panel.js';
import { youtubeButton, publicUrl, pickYouTubeVideo, youtubeStudioUrl, youtubeThumbUrl } from './youtube.js';
import { h, fmtDur, fmtSize, fmtDate, fmtAgo, extFor, toast, probeDuration, openModal, popMenu, micIcon, uploadIcon, dotsIcon, eyeIcon, loveIcon, likeIcon, commentIcon, shareIcon, pencilIcon, playIcon, pauseIcon } from './ui.js';

// One place to change the upload limits.
// Every published item (and every recap part) is at most 10 minutes. Items published before this rule keep working.
export const LIMITS = { videoSeconds: 600, videoMB: 500, audioSeconds: 600, audioMB: 100 };

// The device's default for the "Allow download" switch of new items (Settings changes it).
export const allowDownloadDefault = () => { try { return JSON.parse(localStorage.getItem('fabstudio.prefs') || '{}').allowDownload !== false; } catch { return true; } };
const AUDIO_EXT = ['mp3', 'm4a', 'webm', 'ogg'];
const STATUS = { draft: 'Draft', published: 'Published', unpublished: 'Unpublished' };
const MB = 1048576;

const pickFile = (accept) => new Promise((resolve) => {
  const input = h('input', { type: 'file', accept });
  input.onchange = () => resolve(input.files[0] || null);
  input.oncancel = () => resolve(null);
  input.click();
});

// Returns an error message, or '' when the file is fine.
export async function checkSource(file, kind) {
  const ext = extFor(file.type, file.name);
  if (kind === 'video') {
    if (ext !== 'mp4') return 'Videos must be MP4 (H.264).';
    if (file.size > LIMITS.videoMB * MB) return `Videos can be at most ${LIMITS.videoMB} MB.`;
    const d = await probeDuration(file);
    if (d > LIMITS.videoSeconds) return `Videos can be at most ${Math.round(LIMITS.videoSeconds / 60)} minutes.`;
    return '';
  }
  if (!AUDIO_EXT.includes(ext)) return 'Audio must be MP3, M4A, WebM or OGG.';
  if (file.size > LIMITS.audioMB * MB) return `Audio can be at most ${LIMITS.audioMB} MB.`;
  const d = await probeDuration(file);
  if (d > LIMITS.audioSeconds) return `Audio can be at most ${Math.round(LIMITS.audioSeconds / 60)} minutes. Cut it into parts.`;
  return '';
}

const newest = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
const poemLabel = (p) => p.title || (p.stanzas?.[0] || '').split('\n')[0] || 'Untitled';
const withUrl = (blob, img) => { const u = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(u); img.src = u; return img; };

async function snapshot(poemId) {
  return { poemTitle: '', poemStanzas: [] }; // poem text stays in Studio and is never published
}

/* ---------- drafts made by the app ---------- */
function itemRow(o) {
  const t = now();
  return {
    id: o.id, kind: o.kind, poemId: o.poemId || null, title: o.title, description: '', poemTitle: '', poemStanzas: [],
    mime: o.mime, duration: o.duration, mediaKey: `items/${o.id}.${extFor(o.mime, o.name || '')}`, thumbKey: `thumbs/${o.id}.jpg`,
    publicMediaKey: null, publicThumbKey: null, status: 'draft', publishedAt: null, commentsEnabled: true, reactionsEnabled: true,
    createdAt: t, updatedAt: t, dirty: 1, remote: 0, blob: o.blob, thumbBlob: o.thumb, mediaPending: 1, thumbPending: 1,
    thumbKind: o.thumbKind || 'title', needsRepublish: 0, allowDownload: allowDownloadDefault(),
    ...(o.bakeId ? { bakeId: o.bakeId } : {}),
  };
}

// A baked poem lands in Studio as a draft, named after the poem.
export async function createDraftFromBake(bake) {
  const poem = bake.poemId ? await db.poems.get(bake.poemId) : null;
  const title = poem && !poem.deletedAt ? poemLabel(poem) : 'Baked poem';
  const thumb = await thumbFromTitle(title);
  const id = crypto.randomUUID();
  await db.items.put(itemRow({ id, kind: 'audio', poemId: bake.poemId, title, mime: bake.mime || bake.blob.type, duration: bake.duration, blob: bake.blob, thumb, bakeId: bake.id }));
  syncSoon();
  return id;
}

// After a re-bake at a new volume, drafts made from that bake get the new audio. Published items are left alone.
export async function syncDraftFromBake(bakeId) {
  const b = await db.bakes.get(bakeId);
  if (!b || !b.blob) return;
  const drafts = await db.items.filter((x) => x.bakeId === bakeId && x.status === 'draft').toArray();
  for (const it of drafts) await db.items.update(it.id, { blob: b.blob, mime: b.mime, duration: b.duration, mediaPending: 1, updatedAt: now(), dirty: 1 });
  if (drafts.length) syncSoon();
}

/* ---------- the second version of an item: an audio item's video, a video item's audio ---------- */
// The audio taken out of a video, as the fields to save on the item. Empty when this video has no usable audio.
export async function audioOfVideo(id, file) {
  try {
    const a = await extractAudio(file);
    if (!a) return {};
    return { altBlob: a.blob, altMime: a.mime, altKey: `items/${id}.alt.m4a`, altPending: 1, altDuration: a.duration };
  } catch (e) { console.warn('Could not take the audio out of the video', e); return {}; }
}

// Adds (or replaces) the second version from a file the person chose. Returns an error text, or '' when done.
export async function setAltFile(id, file) {
  const row = await db.items.get(id);
  if (!row) return 'That item is gone.';
  if (row.kind === 'audio') {
    const ext = extFor(file.type, file.name);
    if (ext !== 'mp4') return 'The video version must be MP4 (H.264).';
    if (file.size > LIMITS.videoMB * MB) return `Videos can be at most ${LIMITS.videoMB} MB.`;
    const d = await probeDuration(file);
    if (d > LIMITS.videoSeconds) return `Videos can be at most ${Math.round(LIMITS.videoSeconds / 60)} minutes.`;
    await putAlt(row, { blob: file, mime: file.type || 'video/mp4', ext: 'mp4', duration: d });
    return '';
  }
  const ext = extFor(file.type, file.name);
  if (!AUDIO_EXT.includes(ext)) return 'The audio version must be MP3, M4A, WebM or OGG.';
  if (file.size > LIMITS.audioMB * MB) return `Audio can be at most ${LIMITS.audioMB} MB.`;
  await putAlt(row, { blob: file, mime: file.type || 'audio/mpeg', ext, duration: await probeDuration(file) });
  return '';
}

// Saves a second version on the item (replacing any earlier one).
export async function putAlt(row, { blob, mime, ext, duration }) {
  const key = `items/${row.id}.alt.${ext}`;
  if (row.altKey && row.altKey !== key && row.remote) { try { await deleteMedia(row.altKey); } catch { /* the old file stays unused */ } }
  await db.items.update(row.id, {
    altBlob: blob, altMime: mime, altKey: key, altPending: 1, altDuration: duration, publicAltKey: null,
    ...(row.kind === 'audio' && row.youtubeId ? { youtubeId: null } : {}),   // an item has one video: the new file replaces a linked YouTube video
    updatedAt: now(), dirty: 1, ...(row.status === 'published' ? { needsRepublish: 1 } : {}),
  });
  syncSoon();
}

// A post that only plays from YouTube (it has no audio or video file of its own).
export const ytOnly = (r) => !!r.youtubeId && !r.mediaKey && !r.publicMediaKey;

// Links a YouTube video to an audio item: it becomes the item's video, next to the audio. A video file that was
// uploaded before is replaced, because an item has one video. Returns an error text, or '' when done.
export async function linkYoutube(id, videoId) {
  const row = await db.items.get(id);
  if (!row) return 'That item is gone.';
  if (row.kind !== 'audio') return 'Only an audio item can have a YouTube video.';
  if (row.altKey) await removeAlt(id);
  await db.items.update(id, { youtubeId: videoId, updatedAt: now(), dirty: 1 });
  syncSoon();
  return '';
}
export async function unlinkYoutube(id) {
  await db.items.update(id, { youtubeId: null, updatedAt: now(), dirty: 1 });
  syncSoon();
}

// A post that only plays from YouTube gets its own audio file: it becomes an audio item whose Watch side is the
// YouTube video (the same shape as any audio item with a linked YouTube video). The public page changes when Update is pressed.
// Returns an error text, or '' when done.
export async function addAudioToYoutubePost(id, file) {
  const row = await db.items.get(id);
  if (!row) return 'That item is gone.';
  if (!ytOnly(row)) return 'This item already has its own file.';
  const problem = await checkSource(file, 'audio');
  if (problem) return problem;
  const ext = extFor(file.type, file.name);
  const mime = file.type || 'audio/mpeg';
  // the picture stays the one it has on the public page; when that cannot be read, a card with the title is made
  let thumb = null;
  let thumbKind = 'custom';
  try {
    if (row.publicThumbKey) { const r = await fetch(publicUrl(row.publicThumbKey)); if (r.ok) thumb = await r.blob(); }
  } catch { /* the title card below is used */ }
  if (!thumb || !thumb.size) { thumb = await thumbFromTitle(row.title || 'Untitled'); thumbKind = 'title'; }
  await db.items.update(id, {
    kind: 'audio', mime, blob: file, duration: await probeDuration(file),
    mediaKey: `items/${id}.${ext}`, mediaPending: 1,
    thumbKey: `thumbs/${id}.jpg`, thumbBlob: thumb, thumbPending: 1, thumbKind,
    allowDownload: row.allowDownload ?? allowDownloadDefault(),
    updatedAt: now(), dirty: 1, needsRepublish: 1,
  });
  syncSoon();
  return '';
}

// Takes the second version away (the file is deleted online too).
export async function removeAlt(id) {
  const row = await db.items.get(id);
  if (!row || !row.altKey) return;
  if (row.remote) { try { await deleteMedia(row.altKey); } catch { /* ignore */ } }
  await db.items.update(id, {
    altBlob: undefined, altMime: null, altKey: null, altPending: 0, altDuration: null, publicAltKey: null,
    updatedAt: now(), dirty: 1, ...(row.status === 'published' ? { needsRepublish: 1 } : {}),
  });
  syncSoon();
}

// The audio of a video item that was published before versions existed (or whose audio could not be taken out).
export async function makeAudioVersion(id) {
  const row = await db.items.get(id);
  if (!row || row.kind !== 'video') return 'Only a video has an audio version made from it.';
  let blob = row.blob;
  if (!blob) { if (!navigator.onLine) return 'This needs internet.'; blob = await fetchMedia(row.mediaKey); }
  const a = await extractAudio(blob);
  if (!a) return 'This video has no sound that can be copied out. Add an audio file yourself.';
  await putAlt(row, { blob: a.blob, mime: a.mime, ext: 'm4a', duration: a.duration });
  return '';
}

// An uploaded audio or video file is saved as a draft first.
export async function createDraftFromFile(kind, file) {
  const problem = await checkSource(file, kind);
  if (problem) throw new Error(problem);
  const duration = await probeDuration(file);
  const title = file.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || 'Untitled';
  let thumb;
  let thumbKind = 'title';
  try { if (kind === 'video') { thumb = await thumbFromVideo(file); thumbKind = 'video'; } else thumb = await thumbFromTitle(title); } catch { thumb = await thumbFromTitle(title); thumbKind = 'title'; }
  const id = crypto.randomUUID();
  const mime = file.type || (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
  const row = itemRow({ id, kind, title, mime, duration, blob: file, thumb, thumbKind, name: file.name });
  // A video also gets its audio version, taken out of the file without re-encoding (about a second).
  if (kind === 'video') Object.assign(row, await audioOfVideo(id, file));
  await db.items.put(row);
  syncSoon();
  return id;
}

// Publishing runs in the background (see publisher.js): this only puts the item in the queue.
// The promise settles when the item is published or the job fails.
export function publishItemNow(id, title = '') {
  return requestPublish(id, title);
}

/* ---------- shared actions (used by the list menu and the item page) ---------- */
const needNet = () => { if (!navigator.onLine) throw new Error('This needs internet.'); };

// Saves an item's audio or video to this device as "Fabris Poet - <Title>.<ext>". The file comes from this
// device when it is here, otherwise it is fetched first (that needs internet).
async function downloadItem(id, alt = false) {
  const row = await db.items.get(id);
  if (!row) return false;
  const key = alt ? row.altKey : row.mediaKey;
  if (!key) return false;
  let blob = alt ? row.altBlob : row.blob;
  if (!blob) {
    needNet();
    toast('Getting the file…');
    blob = await fetchMedia(key);
    await db.items.update(id, alt ? { altBlob: blob } : { blob });
  }
  const name = downloadName(row.title, extOf({ key, mime: alt ? row.altMime : row.mime }));
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Downloading ' + name);
  return false;   // nothing in the list changed
}

async function copyLink(id) {
  const link = `${location.origin}/p/${id}`;
  try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch { toast(link); }
}

// Both return true when the thing was done, false when the person backed out.
async function unpublishFlow(id) {
  needNet();
  if (!confirm('Unpublish? Listeners lose access. Reactions and comments are kept.')) return false;
  await unpublishItem(id);
  await db.items.update(id, { status: 'unpublished', publicMediaKey: null, publicThumbKey: null, publicAltKey: null, publicBgKey: null, needsRepublish: 0, updatedAt: now(), dirty: 1 });
  await syncAndWait();
  toast('Unpublished.');
  return true;
}

// Removes one item (online files, reactions and comments too when it was saved online). ask=false skips the question
// so several can be deleted after a single confirmation.
async function removeItem(row) {
  if (row.remote) {
    await deleteItemFiles(row.id);
    const { error } = await sb.from('published_items').delete().eq('id', row.id);
    if (error) throw error;
  }
  await db.items.delete(row.id);
  await db.uploads.delete(row.mediaKey);
  await db.uploads.delete(row.thumbKey);
}

async function deleteFlow(id) {
  const row = await db.items.get(id);
  if (!row) return false;
  if (row.remote) {
    needNet();
    if (!confirm('Delete this item completely? Its files, reactions and comments are removed for good.')) return false;
  } else if (!confirm('Delete this draft?')) return false;
  await removeItem(row);
  toast('Deleted.');
  return true;
}

// Several at once (Select, then Delete). Items that are publishing right now are left alone.
async function deleteItemsFlow(ids) {
  const rows = (await Promise.all(ids.map((id) => db.items.get(id)))).filter(Boolean);
  const todo = rows.filter((r) => !isBusy(r.id));
  const skipped = rows.length - todo.length;
  if (!todo.length) { toast('Those are publishing right now. Try again when they are done.'); return false; }
  if (todo.some((r) => r.remote)) needNet();
  const online = todo.filter((r) => r.remote).length;
  if (!confirm(`Delete ${todo.length} item${todo.length === 1 ? '' : 's'}?${online ? `\n${online} saved online: files, reactions and comments are removed for good.` : ''}${todo.length - online ? `\n${todo.length - online} draft${todo.length - online === 1 ? '' : 's'} on this device.` : ''}`)) return false;
  let done = 0;
  for (const r of todo) { try { await removeItem(r); done++; } catch (e) { toast(`Could not delete "${r.title || 'Untitled'}": ${e.message || e}`); } }
  toast(`${done} deleted${skipped ? `, ${skipped} skipped (publishing)` : ''}.`);
  return done > 0;
}

/* ---------- views, reactions and comments (read only here) ---------- */
const counterCache = new Map(); // item id -> counters row, so a list shows the last numbers at once
async function loadCounters() {
  if (!navigator.onLine) return;
  const { data, error } = await sb.from('counters').select('*');
  if (error) throw error;
  for (const c of data || []) counterCache.set(c.item_id, c);
}

// Love is no longer shown on posts (its data stays in the database).
const STAT_DEFS = [[eyeIcon, 'n_views', 'Views'], [likeIcon, 'n_like', 'Like'], [commentIcon, 'n_comments', 'Comments']];
function statsEl(c) {
  const spans = STAT_DEFS.map(([icon, key, label]) => {
    const n = h('b', {}, '–');
    const s = h('span', { title: label }, icon(15), n);
    s._n = n; s._key = key;
    return s;
  });
  const el = h('div', { class: 'stats' }, spans);
  el.paint = (row) => { for (const s of spans) s._n.textContent = row ? String(row[s._key] || 0) : '–'; };
  el.paint(c);
  return el;
}

const statusText = (r) => (r.status === 'published'
  ? `${ytOnly(r) ? 'From YouTube · ' : ''}Published · ${fmtAgo(r.publishedAt || r.updatedAt)}`
  : `${STATUS[r.status] || r.status} · edited ${fmtAgo(r.updatedAt)}${r.dirty ? ' · waiting to sync' : ''}`);

/* ---------- list (the Studio tab) ---------- */
let listFilter = 'all';
const picked = createSelection();   // Select mode of the Studio list
let editNext = null;
// Extra buttons for the "version" panel of an item page (the animated screen features add theirs here).
let versionButtons = null;
export const setVersionButtons = (fn) => { versionButtons = fn; };                // set by a card's Edit: the item page then opens its edit form straight away

export async function publishListView(nav) {
  const all = (await db.items.toArray()).filter((r) => r.kind !== 'live').sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const rows = all.filter((r) => (listFilter === 'published' ? r.status === 'published' : listFilter === 'drafts' ? r.status !== 'published' : true));
  const stats = new Map(); // item id -> its stat icons
  const lines = new Map(); // item id -> its status line
  const ends = new Map();  // item id -> the badge that shows the percentage while publishing
  const agos = [];         // status lines that count time ("1 min ago") and are redrawn now and then
  const act = async (fn) => { try { if (await fn()) nav.refresh(); } catch (e) { toast(e.message || String(e)); } };

  const filters = h('div', { class: 'filters' }, [['all', 'All'], ['drafts', 'Drafts'], ['published', 'Published']].map(([k, l]) =>
    h('button', { class: 'fchip' + (listFilter === k ? ' on' : ''), type: 'button', onclick: () => { listFilter = k; nav.refresh(); } }, l)));

  const selBar = selectBar(picked, {
    onMode: () => nav.refresh(),
    onDelete: async () => { const ids = [...picked.ids]; if (await deleteItemsFlow(ids).catch((e) => { toast(e.message || String(e)); return false; })) { picked.on = false; picked.ids.clear(); nav.refresh(); } },
  });
  // The three-dot menu of a card: Edit, Open, Download, Copy link and Unpublish (when published), Delete.
  const menuFor = (r) => {
    const dots = h('button', {
      class: 'iconbtn', type: 'button', 'aria-label': 'More',
      onclick: (e) => {
        e.stopPropagation();
        popMenu(dots, [
          // a post that plays from YouTube has no file of its own: Edit opens its Studio page, View public page opens the site, and it leaves the site with Delete
          ...(ytOnly(r) ? [
            { label: 'Edit', onclick: () => { editNext = r.id; nav.open(r.id); } },
            { label: 'View public page', onclick: () => window.open(`/poem/?id=${r.id}`, '_blank') },
          ] : [
            { label: 'Edit', onclick: () => { editNext = r.id; nav.open(r.id); } },
            { label: 'Open', onclick: () => nav.open(r.id) },
            { label: 'Download', onclick: () => act(() => downloadItem(r.id)) },
          ]),
          ...(r.youtubeId ? [{ label: 'Open in YouTube Studio', onclick: () => window.open(youtubeStudioUrl(r.youtubeId), '_blank', 'noopener') }] : []),
          ...(r.status === 'published' ? [{ label: 'Copy link', onclick: () => copyLink(r.id) }, ...(ytOnly(r) ? [] : [{ label: 'Unpublish', onclick: () => act(() => unpublishFlow(r.id)) }])] : []),
          { label: 'Delete', danger: true, onclick: () => act(() => deleteFlow(r.id)) },
        ]);
      },
    }, dotsIcon(20));
    return h('div', { class: 'menuwrap' }, dots);
  };

  const rowEl = (r) => {
    const thumb = r.thumbBlob ? withUrl(r.thumbBlob, h('img', { class: 'thumb', alt: '' }))
      : ytOnly(r) && r.publicThumbKey ? h('img', { class: 'thumb', alt: '', src: publicUrl(r.publicThumbKey) }) : h('div', { class: 'thumb ph' });
    const job = isBusy(r.id) ? jobFor(r.id) : null;
    const failed = jobFor(r.id)?.state === 'error';
    const line = h('div', { class: (failed ? 'sub error' : 'sub') + (r.status === 'published' && !failed ? ' ok' : '') },
      job ? job.label : failed ? 'Publishing failed. Open it to see why.' : statusText(r));
    lines.set(r.id, line);
    if (!job && !failed) agos.push(() => { line.textContent = statusText(r); });

    let end;
    if (picked.on) end = null;                       // while selecting, a tap only ticks
    else if (job) {
      end = h('span', { class: 'badge', style: 'color:var(--accent);border-color:var(--accent)' }, job.pct + '%');
      ends.set(r.id, end);
    } else if (r.status === 'published') {
      end = menuFor(r);
    } else {
      end = h('div', { class: 'row' }, h('button', {
        class: 'btn small primary', type: 'button',
        onclick: (e) => {
          e.stopPropagation();
          requestPublish(r.id, r.title);
          toast(navigator.onLine ? 'Publishing in the background. You can keep using the app.' : 'It will publish when you are back online.');
        },
      }, 'Publish'), menuFor(r));
    }

    const body = h('div', { class: 'grow' }, h('div', { class: 'title' }, r.title || 'Untitled'), line);
    if (r.status === 'published' && !job) {
      const st = statsEl(counterCache.get(r.id));
      stats.set(r.id, st);
      body.append(st);
    }
    const box = picked.on ? tickBox(picked.ids.has(r.id)) : null;
    const li = h('li', { class: 'item' + (picked.on && picked.ids.has(r.id) ? ' picked' : ''), onclick: () => {
      if (!picked.on) return nav.open(r.id);
      if (picked.ids.has(r.id)) picked.ids.delete(r.id); else picked.ids.add(r.id);
      box.checked = picked.ids.has(r.id); li.classList.toggle('picked', box.checked); selBar.paint();
    } }, box, thumb, body, end);
    return li;
  };

  const list = rows.length
    ? h('ul', { class: 'list studio-list' }, rows.map(rowEl))
    : h('p', { class: 'empty' }, listFilter === 'all'
        ? 'Nothing here yet. Tap Bake to record a poem over its tune, or use the upload button to add an audio or video file.'
        : 'Nothing in this view.');

  const upload = h('button', {
    class: 'fab', type: 'button', 'aria-label': 'Upload audio or video',
    onclick: () => {
      const m = openModal(h('h3', {}, 'Upload to Studio'),
        h('p', { class: 'muted small' }, 'The file is saved as a draft first. Publish it from the list.'),
        h('div', { class: 'stack' },
          h('button', { class: 'btn primary', onclick: () => { m.close(); chooseFile('audio'); } }, 'Audio file'),
          h('button', { class: 'btn primary', onclick: () => { m.close(); chooseFile('video'); } }, 'Video file'),
          h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel')));
    },
  }, uploadIcon());
  const chooseFile = async (kind) => {
    const file = await pickFile(kind === 'video' ? 'video/mp4' : 'audio/*');
    if (!file) return;
    try { await createDraftFromFile(kind, file); toast('Saved as a draft. It uploads when you are online.'); listFilter = 'drafts'; nav.refresh(); }
    catch (e) { toast(e.message || String(e)); }
  };

  const live = h('button', { class: 'iconbtn mic', type: 'button', 'aria-label': 'Go live (coming later)', onclick: () => toast('Going live comes in a later phase.') }, micIcon(22));
  const el = h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Studio'),
      h('div', { class: 'row' }, youtubeButton(() => nav.refresh()), live, window.matchMedia('(min-width: 900px)').matches ? h('button', { class: 'btn primary', onclick: () => nav.bake() }, 'Bake') : null)),
    filters, selBar.el, list, upload);

  if (navigator.onLine && stats.size) {
    loadCounters().then(() => { for (const [id, st] of stats) st.paint(counterCache.get(id)); }).catch(() => {});
  }
  const clock = setInterval(() => { if (el.isConnected) agos.forEach((f) => f()); }, 30000);

  // Live percentage on each row while it publishes. When a job starts or ends, the list is redrawn.
  const off = onPublishJobs((job) => {
    if (!el.isConnected) return;
    if (job.state === 'done' || job.state === 'error') return nav.refresh();
    const end = ends.get(job.id);
    if (!end) {
      if (rows.some((r) => r.id === job.id)) nav.refresh(); // started somewhere else
      return;
    }
    end.textContent = job.pct + '%';
    const line = lines.get(job.id);
    if (line) line.textContent = job.label;
  });
  el._dispose = () => { clearInterval(clock); off(); };
  return el;
}

/* ---------- item editor ---------- */
export async function itemView(id, nav, prefill = {}) {
  const existing = await db.items.get(id);
  if (existing) return existingView(existing, nav);
  const poems = (await db.poems.toArray()).filter((p) => !p.deletedAt).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const baked = (await db.bakes.toArray()).filter((b) => !b.deletedAt && b.blob).sort(newest);
  const poemById = new Map(poems.map((p) => [p.id, p]));

  const title = h('input', { placeholder: 'Title', value: existing?.title || '', 'aria-label': 'Title' });
  const desc = h('textarea', { placeholder: 'Short description (optional)', rows: 3, 'aria-label': 'Description' });
  desc.value = existing?.description || '';
  const poemSel = h('select', { 'aria-label': 'Linked poem' }, h('option', { value: '' }, 'No linked poem'), poems.map((p) => h('option', { value: p.id }, poemLabel(p))));
  poemSel.value = existing?.poemId || '';
  const comments = h('input', { type: 'checkbox', checked: existing ? existing.commentsEnabled : true });
  const reactions = h('input', { type: 'checkbox', checked: existing ? existing.reactionsEnabled : true });
  const allowDl = h('input', { type: 'checkbox', checked: allowDownloadDefault() });
  const details = h('div', { class: 'panel' },
    h('h3', {}, 'Details'), title, desc,
    h('label', {}, h('span', { class: 'muted small' }, 'Show this poem’s text on the page'), poemSel),
    h('label', { class: 'row check' }, comments, h('span', {}, 'Allow comments')),
    h('label', { class: 'row check' }, reactions, h('span', {}, 'Allow reactions')),
    h('label', { class: 'row check' }, allowDl, h('span', {}, 'Allow download')));

  const back = h('button', { class: 'btn small', onclick: () => nav.back() }, '← Studio');
  const root = h('section', { class: 'view' }, h('div', { class: 'toolbar' }, back));

  /* new item: choose source, thumbnail, details, then save as draft */
  let src = null;     // { kind, blob, mime, duration, name }
  let thumb = null;   // JPEG blob
  let thumbKind = 'title'; // where it came from: title, image or video
  const srcInfo = h('p', { class: 'muted' }, 'Choose what to publish.');
  const preview = h('img', { class: 'thumb big', alt: 'Thumbnail preview', hidden: true });
  const showThumb = (blob, kind = 'custom') => { thumb = blob; thumbKind = kind; withUrl(blob, preview); preview.hidden = false; };
  const bakeSel = h('select', { hidden: true, 'aria-label': 'Baked poem' }, baked.map((b) => {
    const p = poemById.get(b.poemId);
    return h('option', { value: b.id }, `${p ? poemLabel(p) : 'Poem'}, ${fmtDate(b.createdAt)}, ${fmtDur(b.duration)}`);
  }));
  const setSource = async (s) => {
    src = s;
    srcInfo.textContent = `${s.kind === 'video' ? 'Video' : 'Audio'}, ${fmtDur(s.duration)}, ${fmtSize(s.blob.size)}`;
    if (s.kind === 'video') { try { showThumb(await thumbFromVideo(s.blob), 'video'); } catch { /* choose another thumbnail */ } }
  };
  const useBake = async (b) => {
    if (!b) return toast('No baked audio yet. Bake a poem first.');
    if (!title.value && poemById.get(b.poemId)) title.value = poemLabel(poemById.get(b.poemId));
    if (b.poemId) poemSel.value = b.poemId;
    await setSource({ kind: 'audio', blob: b.blob, mime: b.mime || b.blob.type, duration: b.duration, name: 'bake.' + extFor(b.mime) });
  };
  const useFile = async (kind) => {
    const file = await pickFile(kind === 'video' ? 'video/mp4' : 'audio/*');
    if (!file) return;
    const problem = await checkSource(file, kind);
    if (problem) return toast(problem);
    await setSource({ kind, blob: file, mime: file.type || (kind === 'video' ? 'video/mp4' : 'audio/mpeg'), duration: await probeDuration(file), name: file.name });
  };
  const sourcePanel = h('div', { class: 'panel' }, h('h3', {}, '1. What to publish'),
    h('div', { class: 'seg' },
      h('button', { class: 'btn', onclick: async () => { bakeSel.hidden = !baked.length; await useBake(baked.find((b) => b.id === bakeSel.value) || baked[0]); } }, 'Baked poem'),
      h('button', { class: 'btn', onclick: () => useFile('audio') }, 'Audio file'),
      h('button', { class: 'btn', onclick: () => useFile('video') }, 'Video file')),
    bakeSel, srcInfo);
  bakeSel.onchange = () => useBake(baked.find((b) => b.id === bakeSel.value));

  let thumbLook = 0;
  const thumbPanel = h('div', { class: 'panel' }, h('h3', {}, '2. Thumbnail'),
    h('p', { class: 'muted small' }, 'Leave it and a title card is drawn for you. Or upload an image, redraw the card, or pick a frame of a video.'),
    preview,
    h('div', { class: 'seg' }, h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        const r = await pickThumbnail({ title: title.value.trim() || 'Untitled', video: src?.kind === 'video' ? src.blob : null, current: thumb, look: thumbLook });
        if (r) { showThumb(r.blob, r.kind); thumbLook = r.look; }
      },
    }, 'Choose thumbnail')));

  const save = h('button', {
    class: 'btn primary wide',
    onclick: async () => {
      if (!src) return toast('Choose what to publish first.');
      if (!title.value.trim()) return toast('Give it a title.');
      save.disabled = true;
      try {
        const blob = thumb || await thumbFromTitle(title.value.trim());
        const t = now();
        // A video also gets its audio version, taken out of the file without re-encoding.
        const alt = src.kind === 'video' ? await audioOfVideo(id, src.blob) : {};
        await db.items.put({
          id, kind: src.kind, poemId: poemSel.value || null, title: title.value.trim(), description: desc.value.trim(),
          poemTitle: '', poemStanzas: [], mime: src.mime, duration: src.duration,
          mediaKey: `items/${id}.${extFor(src.mime, src.name)}`, thumbKey: `thumbs/${id}.jpg`,
          publicMediaKey: null, publicThumbKey: null, status: 'draft', publishedAt: null,
          commentsEnabled: comments.checked, reactionsEnabled: reactions.checked,
          createdAt: t, updatedAt: t, dirty: 1, remote: 0, blob: src.blob, thumbBlob: blob, mediaPending: 1, thumbPending: 1,
          thumbKind: thumb ? thumbKind : 'title', thumbVariant: thumbLook, needsRepublish: 0, allowDownload: allowDl.checked, ...alt,
        });
        syncSoon();
        toast('Draft saved. It uploads when you are online.');
        nav.open(id);
      } catch (e) { toast('Could not save: ' + (e.message || e)); save.disabled = false; }
    },
  }, 'Save draft');

  root.append(h('h2', {}, 'New item'), sourcePanel, thumbPanel, details, save);
  if (prefill.bakeId) { const b = baked.find((x) => x.id === prefill.bakeId); if (b) { bakeSel.value = b.id; bakeSel.hidden = false; await useBake(b); } }
  return root;
}

/* ---------- one screen of the item page ---------- */
// The thumbnail with play. An audio screen has a seek bar; a video plays in place.
// playable false = the greyed-out screen of a version that is not made yet; overlay says what to do.
function screenPlayer({ kind, getBlob, duration, playable, overlay = [], onPlay }) {
  const wrap = h('div', { class: 'cover-wrap' + (playable ? '' : ' off') });
  const img = h('img', { class: 'cover', alt: kind === 'video' ? 'Video screen' : 'Audio screen' });
  const ph = h('div', { class: 'cover ph' });
  let video = null; let audio = null; let mediaUrl = null; let seeking = false;
  const setThumb = (url) => {
    if (video) { if (url) video.poster = url; return; }
    if (url) { img.src = url; if (!img.isConnected) wrap.prepend(img); ph.remove(); } else { img.remove(); if (!ph.isConnected) wrap.prepend(ph); }
  };
  const pause = () => { audio?.pause(); video?.pause(); };
  const dispose = () => { pause(); if (mediaUrl) URL.revokeObjectURL(mediaUrl); };
  if (!playable) {
    wrap.append(h('div', { class: 'cover-off' }, overlay));
    return { el: wrap, setThumb, pause, dispose };
  }
  const playBtn = h('button', { class: 'cover-play', type: 'button', 'aria-label': 'Play' }, playIcon(26));
  wrap.append(playBtn);
  const cur = h('span', {}, '0:00');
  const tot = h('span', {}, fmtDur(duration));
  const seek = h('input', { type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Seek' });
  if (kind !== 'video') wrap.append(h('div', { class: 'cover-bar' }, cur, seek, tot));
  const lenOf = () => (audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration || 0);
  seek.oninput = () => { seeking = true; cur.textContent = fmtDur((seek.value / 1000) * lenOf()); };
  seek.onchange = () => { if (audio) audio.currentTime = (seek.value / 1000) * lenOf(); seeking = false; };
  playBtn.onclick = async () => {
    if (kind === 'video') {
      if (mediaUrl) return;
      playBtn.disabled = true;
      const blob = await getBlob();
      playBtn.disabled = false;
      if (!blob) return toast('Not on this device yet. Connect to the internet to download it.');
      mediaUrl = URL.createObjectURL(blob);
      const v = h('video', { class: 'cover', controls: true, playsinline: true });
      const poster = img.src;
      if (poster) v.poster = poster;
      v.src = mediaUrl;
      v.onplay = () => onPlay?.();
      video = v;
      wrap.replaceChildren(v);
      v.play().catch(() => {});
      return;
    }
    if (audio) { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); return; }
    playBtn.disabled = true;
    const blob = await getBlob();
    playBtn.disabled = false;
    if (!blob) return toast('Not on this device yet. Connect to the internet to download it.');
    mediaUrl = URL.createObjectURL(blob);
    audio = new Audio(mediaUrl);
    audio.onplay = () => { playBtn.replaceChildren(pauseIcon(26)); onPlay?.(); };
    audio.onpause = () => playBtn.replaceChildren(playIcon(26));
    audio.onended = () => { playBtn.replaceChildren(playIcon(26)); seek.value = 0; cur.textContent = '0:00'; };
    audio.ontimeupdate = () => {
      if (seeking) return;
      const len = lenOf();
      cur.textContent = fmtDur(audio.currentTime);
      if (len) seek.value = Math.min(1000, Math.round((audio.currentTime / len) * 1000));
    };
    audio.onerror = () => toast('This audio could not be played.');
    audio.play().catch(() => {});
  };
  return { el: wrap, setThumb, pause, dispose };
}

/* ---------- saved item: the page for one item ---------- */
// Reads like the public poem page: title, picture with play, when it went out, description, the numbers
// (read only), share. Only the title and description are edited here, each with its pen.
async function existingView(first, nav) {
  const id = first.id;
  let item = first;
  const root = h('section', { class: 'view item-page' });
  const disposers = [];
  root._dispose = () => disposers.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  // Node.replaceChildren turns null into the text "null", so empty slots are dropped first.
  const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const penBtn = (label, onclick) => h('button', { class: 'iconbtn accent', type: 'button', 'aria-label': label, onclick }, pencilIcon(18));
  const published = () => item.status === 'published';
  const fromYt = () => ytOnly(item);   // plays from YouTube: no file of its own, so no file actions

  /* title */
  const titleText = h('h2', { class: 'item-title' });
  const titleBox = h('div', { class: 'edit-row' });
  const showTitle = () => {
    titleText.textContent = item.title || 'Untitled';
    titleBox.classList.remove('editing');
    put(titleBox, titleText, penBtn('Edit title', editTitle));
  };
  async function changeTitle(t) {
    const patch = { title: t, updatedAt: now(), dirty: 1 };
    // The thumbnail card shows the title, so it is redrawn with it. Pictures you chose yourself stay.
    let kind = item.thumbKind;
    if (fromYt()) { await db.items.update(id, { title: t, updatedAt: now(), dirty: 1 }); item = await db.items.get(id); syncSoon(); showTitle(); paintStatus(); toast('Saved.'); return; }
    if (!kind) kind = confirm('Also update the thumbnail card to show the new title?\nChoose Cancel to keep the current picture.') ? 'title' : 'custom';
    if (kind === 'title') {
      patch.thumbBlob = await thumbFromTitle(t, 'Fabris Poet', item.thumbVariant || 0);
      patch.thumbPending = 1;
      if (published()) patch.needsRepublish = 1;
    }
    patch.thumbKind = kind;
    await db.items.update(id, patch);
    item = await db.items.get(id);
    syncSoon();
    setThumb();
    showTitle();
    paintStatus();
    paintActions();
    toast('Saved.');
  }
  function editTitle() {
    const input = h('input', { value: item.title || '', 'aria-label': 'Title', maxlength: 120 });
    const save = h('button', { class: 'btn small primary', type: 'button' }, 'Save');
    const cancel = h('button', { class: 'btn small', type: 'button', onclick: showTitle }, 'Cancel');
    const go = async () => {
      const t = input.value.trim();
      if (!t) return toast('Give it a title.');
      if (t === (item.title || '')) return showTitle();
      save.disabled = true;
      try { await changeTitle(t); } catch (e) { toast(e.message || String(e)); save.disabled = false; }
    };
    save.onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    titleBox.classList.add('editing');
    put(titleBox, h('div', { class: 'edit-form' }, input, h('div', { class: 'row' }, save, cancel)));
    input.focus();
    input.select();
  }

  /* one Edit form for the title, the description and the thumbnail (the pens below still work too) */
  function openEdit() {
    const ti = h('input', { value: item.title || '', 'aria-label': 'Title', maxlength: 120 });
    const ta = h('textarea', { rows: 5, 'aria-label': 'Description', placeholder: 'Short description (optional)', maxlength: 1000 });
    ta.value = item.description || '';
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const thumbBtn = h('button', { class: 'btn', type: 'button', onclick: () => editThumb() }, 'Change thumbnail');
    const m = openModal(h('h3', {}, 'Edit'),
      h('label', {}, h('span', { class: 'muted small' }, 'Title'), ti),
      h('label', {}, h('span', { class: 'muted small' }, 'Description'), ta),
      fromYt() ? null : h('div', { class: 'row' }, thumbBtn),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), cancel, save));
    cancel.onclick = () => m.close();
    save.onclick = async () => {
      const t = ti.value.trim();
      const d = ta.value.trim();
      if (!t) return toast('Give it a title.');
      save.disabled = true;
      try {
        if (d !== (item.description || '')) {
          await db.items.update(id, { description: d, updatedAt: now(), dirty: 1 });
          item = await db.items.get(id);
          syncSoon();
          paintDesc();
        }
        if (t !== (item.title || '')) await changeTitle(t); else { paintStatus(); toast('Saved.'); }
        m.close();
      } catch (e) { toast(e.message || String(e)); save.disabled = false; }
    };
    ti.focus();
  }

  /* the thumbnail, shared by both screens */
  const players = [];   // every screen on the page shows the thumbnail
  let thumbUrl = null;
  function setThumb() {
    const old = thumbUrl;
    thumbUrl = item.thumbBlob ? URL.createObjectURL(item.thumbBlob) : null;
    players.forEach((p) => p.setThumb(thumbUrl));
    if (old) URL.revokeObjectURL(old);
  }
  if (!item.thumbBlob && navigator.onLine) {
    fetchMedia(item.thumbKey).then(async (b) => { await db.items.update(id, { thumbBlob: b }); item = await db.items.get(id); setThumb(); }).catch(() => {});
  }
  async function editThumb() {
    const row = await db.items.get(id);
    const r = await pickThumbnail({ title: item.title || 'Untitled', video: item.kind === 'video' ? row?.blob || null : null, current: item.thumbBlob || null, look: item.thumbVariant || 0 });
    if (!r) return;
    await db.items.update(id, { thumbBlob: r.blob, thumbPending: 1, thumbKind: r.kind, thumbVariant: r.look, updatedAt: now(), dirty: 1, ...(published() ? { needsRepublish: 1 } : {}) });
    item = await db.items.get(id);
    syncSoon();
    setThumb();
    paintStatus();
    paintActions();
    toast(published() ? 'Saved. Press Update to show it on the public page.' : 'Thumbnail saved.');
  }
  const getPrimaryBlob = async () => {
    const row = await db.items.get(id);
    if (row?.blob) return row.blob;
    try { const b = await fetchMedia(row.mediaKey); await db.items.update(id, { blob: b }); return b; } catch { return null; }
  };
  const getAltBlob = async () => {
    const row = await db.items.get(id);
    if (row?.altBlob) return row.altBlob;
    if (!row?.altKey) return null;
    try { const b = await fetchMedia(row.altKey); await db.items.update(id, { altBlob: b }); return b; } catch { return null; }
  };
  disposers.push(() => { players.forEach((p) => p.dispose()); if (thumbUrl) URL.revokeObjectURL(thumbUrl); });

  /* when it went out */
  const status = h('div', { class: 'sub' });
  function paintStatus() {
    status.className = 'sub' + (published() ? ' ok' : '');
    status.textContent = published()
      ? `Published · ${fmtAgo(item.publishedAt || item.updatedAt)}`
      : `${STATUS[item.status] || item.status} · edited ${fmtAgo(item.updatedAt)}`;
  }
  const clock = setInterval(() => { if (root.isConnected) paintStatus(); }, 30000);
  disposers.push(() => clearInterval(clock));

  /* description: one line with "more...", opens to the whole text */
  let open = false;
  const descP = h('p', { class: 'desc' });
  const more = h('button', { class: 'linkbtn', type: 'button', onclick: () => { open = !open; paintDesc(); } });
  const descBox = h('div', { class: 'edit-row' });
  function paintDesc() {
    const d = item.description || '';
    descBox.classList.remove('editing');
    descP.className = d ? 'desc' + (open ? '' : ' clamp') : 'desc muted';
    descP.textContent = d || 'No description yet.';
    more.hidden = !d || !(open || d.length > 40 || d.includes('\n'));
    more.textContent = open ? 'less' : 'more...';
    put(descBox, h('div', { class: 'grow' }, descP, more), penBtn('Edit description', editDesc));
  }
  function editDesc() {
    const ta = h('textarea', { rows: 4, 'aria-label': 'Description', placeholder: 'Short description (optional)', maxlength: 1000 });
    ta.value = item.description || '';
    const save = h('button', { class: 'btn small primary', type: 'button' }, 'Save');
    save.onclick = async () => {
      save.disabled = true;
      try {
        await db.items.update(id, { description: ta.value.trim(), updatedAt: now(), dirty: 1 });
        item = await db.items.get(id);
        syncSoon();
        paintDesc();
        paintStatus();
        toast('Saved.');
      } catch (e) { toast(e.message || String(e)); save.disabled = false; }
    };
    descBox.classList.add('editing');
    put(descBox, h('div', { class: 'edit-form' }, ta, h('div', { class: 'row' }, save, h('button', { class: 'btn small', type: 'button', onclick: paintDesc }, 'Cancel'))));
    ta.focus();
  }

  /* numbers (read only) and share */
  const numbers = statsEl(counterCache.get(id));
  const statRow = h('div', { class: 'statrow' }, numbers, h('span', { class: 'grow' }),
    h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Copy link', onclick: () => copyLink(id) }, shareIcon(22)));
  const commentsBox = h('div', { class: 'panel', hidden: true });

  /* publishing progress (it carries on if you leave the page) */
  const progressSlot = h('div', {});
  let job = jobFor(id);
  let busy = isBusy(id);
  const pLabel = h('span', { class: 'grow' }, job?.label || '');
  const pPct = h('strong', {}, (job?.pct || 0) + '%');
  const pBar = h('progress', { max: 100, value: job?.pct || 0 });
  function paintProgress() {
    job = jobFor(id);
    busy = isBusy(id);
    pLabel.textContent = job?.label || '';
    pPct.textContent = (job?.pct || 0) + '%';
    pBar.value = job?.pct || 0;
    put(progressSlot,
      busy ? h('div', { class: 'panel' }, h('h3', {}, 'Publishing'), h('div', { class: 'row' }, pLabel, pPct), pBar,
        h('p', { class: 'muted small' }, 'This keeps going in the background. You can leave this page.')) : null,
      !busy && job?.state === 'error' ? h('p', { class: 'error' }, 'Publishing failed: ' + job.error) : null);
  }

  /* the two screens: audio on the left, video on the right, the same size. A version not made yet is greyed out. */
  const isAudioItem = () => item.kind === 'audio';
  const screensBox = h('div', { class: 'screens' });
  const sceneBox = h('div', {});   // Screen settings card (audio items only)
  const sig = () => JSON.stringify([item.altKey, item.altDuration, item.altPending, !!item.scene, item.duration, item.youtubeId || null]);
  let shown = '';
  async function altChanged() {
    item = await db.items.get(id);
    if (sig() !== shown) paintScreens();   // the screens are only redrawn when a version changed, so playing is not interrupted
    paintScene();
    paintActions();
  }
  function paintScene() {
    if (item.kind !== 'audio') { sceneBox.replaceChildren(); return; }
    put(sceneBox, scenePanel({ id, item, db, now, syncSoon, fetchMedia, putAlt, changed: altChanged }));
  }
  const runVersion = async (fn, btn) => {
    if (btn) btn.disabled = true;
    try { const problem = await fn(); if (problem) toast(problem); else await altChanged(); } catch (e) { toast(e.message || String(e)); }
    finally { if (btn) btn.disabled = false; }
  };
  const uploadVersion = async () => {
    const file = await pickFile(isAudioItem() ? 'video/mp4' : 'audio/*');
    if (!file) return '';
    const problem = await setAltFile(id, file);
    if (!problem && isAudioItem() && item.duration && Math.abs((await probeDuration(file)) - item.duration) > 3) toast('This video is not the same length as the audio. It was added anyway.');
    return problem;
  };
  const goToSettings = () => {
    sceneBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    sceneBox.classList.add('flash');
    setTimeout(() => sceneBox.classList.remove('flash'), 1400);
  };
  // The Video slot of an audio item: pick a video from your YouTube list (it is linked, nothing is copied) or upload an MP4.
  const pickYoutube = async () => {
    const others = await db.items.filter((x) => x.youtubeId && x.id !== id).toArray();
    pickYouTubeVideo({
      exclude: others.map((x) => x.youtubeId),
      onPick: (v) => runVersion(async () => {
        if (item.altKey && !confirm('Replace the uploaded video with this YouTube video?')) return '';
        const problem = await linkYoutube(id, v.id);
        if (!problem) toast('Video linked. Listeners can now choose Listen or Watch.');
        return problem;
      }),
    });
  };
  function paintScreens() {
    players.splice(0).forEach((p) => p.dispose());
    shown = sig();
    // The video screen when a YouTube video is linked: its picture (a tap opens it on YouTube), a menu and Open in YouTube Studio.
    const youtubeScreen = () => {
      const vid = item.youtubeId;
      const dots = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Video options' }, dotsIcon(20));
      if (!fromYt()) dots.onclick = () => popMenu(dots, [
        { label: 'Pick another YouTube video', onclick: pickYoutube },
        { label: 'Replace with an MP4 file', onclick: () => runVersion(uploadVersion) },
        { label: 'Remove video', danger: true, onclick: () => runVersion(async () => { if (!confirm('Remove the linked YouTube video from this item? The video stays on YouTube.')) return ''; await unlinkYoutube(id); return ''; }) },
      ]);
      const th = h('button', { class: 'btn small', type: 'button', onclick: editThumb }, 'Edit thumbnail');
      const studio = h('button', { class: 'btn small', type: 'button', onclick: () => window.open(youtubeStudioUrl(vid), '_blank', 'noopener') }, 'Open in YouTube Studio');
      return h('div', { class: 'screen' },
        h('div', { class: 'screen-head' }, h('strong', {}, 'Video'), h('span', { class: 'sub grow' }, 'YouTube · youtu.be/' + vid), fromYt() ? null : h('div', { class: 'menuwrap' }, dots)),
        h('a', { class: 'yt-screen', href: `https://youtu.be/${encodeURIComponent(vid)}`, target: '_blank', rel: 'noopener', 'aria-label': 'Open this video on YouTube' },
          h('img', { src: youtubeThumbUrl(vid), alt: '' }), h('span', { class: 'yt-play', 'aria-hidden': 'true' }, '▶')),
        h('div', { class: 'row screen-btns' }, studio, fromYt() ? null : th));
    };
    const screen = (which) => {
      if (fromYt()) {
        if (which === 'video') return youtubeScreen();
        const up = h('button', { class: 'btn small primary', type: 'button' }, 'Upload an audio file');
        up.onclick = async () => {
          const file = await pickFile('audio/*');
          if (!file) return;
          up.disabled = true;
          try {
            const problem = await addAudioToYoutubePost(id, file);
            if (problem) { toast(problem); up.disabled = false; return; }
            toast('Audio added. Press Update to put it on the public page.');
            nav.refresh();
          } catch (e) { toast(e.message || String(e)); up.disabled = false; }
        };
        return h('div', { class: 'screen off' },
          h('div', { class: 'screen-head' }, h('strong', {}, 'Audio'), h('span', { class: 'sub grow' }, 'Not made yet')),
          h('div', { class: 'cover-wrap off' }, h('div', { class: 'cover ph' }),
            h('div', { class: 'cover-off' }, up, h('p', { class: 'small' }, 'The video stays on YouTube. The audio is saved here, so it can be downloaded when you allow it.'))),
          h('div', { class: 'row screen-btns' }, h('button', { class: 'btn small', type: 'button', disabled: true }, 'Download')));
      }
      if (which === 'video' && isAudioItem() && item.youtubeId) return youtubeScreen();
      const mine = item.kind === which;
      const exists = mine || !!item.altKey;
      const label = which === 'audio' ? 'Audio' : 'Video';
      const dur = mine ? item.duration : item.altDuration;
      const size = mine ? item.blob?.size : item.altBlob?.size;
      const meta = exists ? [dur ? fmtDur(dur) : '', size ? fmtSize(size) : ''].filter(Boolean).join(' · ') : 'Not made yet';

      // what shows on the greyed-out screen
      let overlay = [];
      if (!exists && which === 'video') {
        overlay = [
          h('button', { class: 'btn small primary', type: 'button', onclick: pickYoutube }, 'Pick from YouTube'),
          h('p', { class: 'small' }, 'Make the video elsewhere and upload it to YouTube, then pick it here.'),
          h('button', { class: 'linkbtn', type: 'button', onclick: () => runVersion(uploadVersion) }, 'or upload an MP4 file')];
      } else if (!exists) {
        const take = h('button', { class: 'btn small primary', type: 'button' }, 'Take the audio from the video');
        take.onclick = () => runVersion(() => makeAudioVersion(id), take);
        overlay = [take, h('button', { class: 'linkbtn', type: 'button', onclick: () => runVersion(uploadVersion) }, 'or upload an audio file')];
      }
      const p = screenPlayer({
        kind: which, getBlob: mine ? getPrimaryBlob : getAltBlob, duration: dur, playable: exists, overlay,
        onPlay: () => players.forEach((x) => { if (x !== p) x.pause(); }),
      });
      players.push(p);

      // the corner: the pen opens Screen settings; the dots hold Replace and Remove
      const corner = [];
      if (which === 'audio' && isAudioItem()) corner.push(h('button', { class: 'iconbtn accent', type: 'button', 'aria-label': 'Screen settings', onclick: goToSettings }, pencilIcon(18)));
      if (!mine && exists) {
        const dots = h('button', { class: 'iconbtn', type: 'button', 'aria-label': `${label} version options` }, dotsIcon(20));
        const items = [];
        if (which === 'video') items.push({ label: 'Pick from YouTube instead', onclick: pickYoutube });
        items.push({ label: which === 'video' ? 'Replace with an MP4 file' : 'Replace with an audio file', onclick: () => runVersion(uploadVersion) });
        items.push({ label: `Remove ${label.toLowerCase()} version`, danger: true, onclick: () => runVersion(async () => { if (!confirm(`Remove the ${label.toLowerCase()} version?`)) return ''; await removeAlt(id); return ''; }) });
        dots.onclick = () => popMenu(dots, items);
        corner.push(h('div', { class: 'menuwrap' }, dots));
      }

      const dl = h('button', { class: 'btn small', type: 'button', disabled: !exists, onclick: async () => { try { await downloadItem(id, !mine); } catch (e) { toast(e.message || String(e)); } } }, 'Download');
      const th = h('button', { class: 'btn small', type: 'button', disabled: !exists, onclick: editThumb }, 'Edit thumbnail');
      return h('div', { class: 'screen' + (exists ? '' : ' off') },
        h('div', { class: 'screen-head' }, h('strong', {}, label), h('span', { class: 'sub grow' }, meta), corner),
        p.el,
        h('div', { class: 'row screen-btns' }, dl, th));
    };
    put(screensBox, screen('audio'), screen('video'));
    if (thumbUrl) players.forEach((x) => x.setThumb(thumbUrl));
  }

  /* actions */
  const actions = h('div', { class: 'panel' });
  const danger = h('div', { class: 'danger-zone' });
  const guarded = (fn) => async () => {
    [actions, danger].forEach((el) => el.querySelectorAll('button').forEach((b) => { b.disabled = true; }));
    try { await fn(); } catch (e) { toast(e.message || String(e)); }
    finally { nav.refresh(); }
  };
  const flag = (label, key) => {
    const cb = h('input', { type: 'checkbox', checked: item[key] !== false });
    cb.onchange = async () => {
      await db.items.update(id, { [key]: cb.checked, updatedAt: now(), dirty: 1 });
      item = await db.items.get(id);
      syncSoon();
      toast('Saved.');
    };
    return h('label', { class: 'row check' }, cb, h('span', {}, label));
  };
  function paintActions() {
    const go = () => { requestPublish(id, item.title); toast(navigator.onLine ? 'Publishing in the background. You can leave this page.' : 'Saved. It will publish when you are back online.'); };
    const buttons = [];
    if (!fromYt() && !published()) buttons.push(h('button', { class: 'btn primary', type: 'button', onclick: guarded(async () => go()) }, 'Publish'));
    if (!fromYt() && published() && item.needsRepublish) buttons.push(h('button', { class: 'btn primary', type: 'button', onclick: guarded(async () => go()) }, 'Update'));
    if (!fromYt() && published()) buttons.push(h('button', { class: 'btn', type: 'button', onclick: guarded(async () => { await unpublishFlow(id); }) }, 'Unpublish'));
    put(actions,
      h('h3', {}, 'Publishing'),
      flag('Allow comments', 'commentsEnabled'),
      flag('Allow reactions', 'reactionsEnabled'),
      flag('Allow download', 'allowDownload'),
      published() && item.needsRepublish ? h('p', { class: 'muted small' }, 'Something changed (thumbnail or a version). Update to show it on the public page.') : null,
      !busy && (item.mediaPending || item.thumbPending || item.altPending || item.bgPending) ? h('p', { class: 'muted small' }, 'Files are waiting to upload.') : null,
      busy ? null : h('div', { class: 'stack' }, buttons));
    put(danger, busy ? null : h('button', { class: 'btn small danger', type: 'button', onclick: guarded(async () => { if (await deleteFlow(id)) nav.back(); }) }, 'Delete this item'));
  }

  /* put the page together */
  showTitle();
  paintStatus();
  paintDesc();
  paintProgress();
  paintScreens();
  paintScene();
  paintActions();
  setThumb();
  const toolbar = h('div', { class: 'toolbar' }, h('button', { class: 'btn small', type: 'button', onclick: () => nav.back() }, '← Studio'),
    h('button', { class: 'btn small primary', type: 'button', onclick: openEdit }, 'Edit'));
  if (window.matchMedia('(min-width: 900px)').matches) {
    // Laptop: two columns, 2 to 1. What listeners get (the audio and video screens, then what is said about it) on the
    // left; what you do with it (publishing, screen settings, delete) on the right. Phones keep the single column below.
    root.classList.add('item-wide');
    put(root, toolbar,
      h('div', { class: 'ip-grid' },
        h('div', { class: 'ip-main' }, titleBox, status, screensBox, descBox, published() ? statRow : null, commentsBox),
        h('div', { class: 'ip-side' }, progressSlot, actions, sceneBox, danger)));
  } else {
    put(root,
      toolbar,
      titleBox, status, screensBox, descBox,
      published() ? statRow : null,
      progressSlot, sceneBox, actions, danger, commentsBox);
  }

  disposers.push(onPublishJobs((j) => {
    if (j.id !== id || !root.isConnected) return;
    if (j.state === 'done' || j.state === 'error' || !busy) return nav.refresh();
    paintProgress();
  }));

  if (editNext === id) { editNext = null; setTimeout(openEdit, 0); }
  if (published()) loadNumbers();
  async function loadNumbers() {
    if (!navigator.onLine) return;
    try {
      const [, cm] = await Promise.all([
        loadCounters(),
        sb.from('comments').select('*').eq('item_id', id).order('created_at', { ascending: false }).limit(100),
      ]);
      numbers.paint(counterCache.get(id));
      if (cm.error) throw cm.error;
      showComments(cm.data || []);
    } catch { /* the numbers stay as they were */ }
  }
  // Moderation stays here, because comments are only made on the public page. The panel shows only when there are comments.
  function showComments(list) {
    commentsBox.hidden = !list.length;
    if (!list.length) return;
    const run = (label, fn, cls = '') => h('button', { class: 'btn small ' + cls, type: 'button', onclick: async () => { const { error } = await fn(); if (error) toast(error.message); else loadNumbers(); } }, label);
    put(commentsBox,
      h('h3', {}, 'Comments'),
      h('ul', { class: 'list' }, list.map((x) => h('li', { class: 'item col' },
        h('div', {}, h('strong', {}, x.nickname), h('span', { class: 'sub' }, ` ${fmtDate(x.created_at)}${x.hidden ? ', hidden' : ''}`)),
        h('div', {}, x.body),
        h('div', { class: 'seg' },
          run(x.hidden ? 'Show' : 'Hide', () => sb.from('comments').update({ hidden: !x.hidden }).eq('id', x.id)),
          run('Delete', () => sb.from('comments').delete().eq('id', x.id), 'danger'),
          run('Block viewer', () => sb.from('viewer_profiles').upsert({ user_id: x.user_id, nickname: x.nickname, blocked: true }), 'danger'))))));
  }
  return root;
}