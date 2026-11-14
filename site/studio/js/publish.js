// Publishing: turn a baked poem, an audio file or a video into something the public can play.
// Drafts are made offline. Publishing, unpublishing and deleting need internet.
import { sb } from '../../shared/supabase.js';
import { db, now } from './db.js';
import { syncSoon, syncAndWait, getSyncState } from './sync.js';
import { publishItem, unpublishItem, deleteItemFiles, fetchMedia } from './api.js';
import { thumbFromImage, thumbFromTitle, thumbFromVideo } from './thumbs.js';
import { h, fmtDur, fmtSize, fmtDate, extFor, toast, probeDuration, playButton, openModal, micIcon, uploadIcon } from './ui.js';

// One place to change the upload limits.
export const LIMITS = { videoSeconds: 300, videoMB: 150, audioMB: 100 };
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
  return '';
}

const newest = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
const poemLabel = (p) => p.title || (p.stanzas?.[0] || '').split('\n')[0] || 'Untitled';
const withUrl = (blob, img) => { const u = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(u); img.src = u; return img; };

async function snapshot(poemId) {
  const p = poemId ? await db.poems.get(poemId) : null;
  return p && !p.deletedAt ? { poemTitle: p.title || '', poemStanzas: p.stanzas || [] } : { poemTitle: '', poemStanzas: [] };
}

/* ---------- drafts made by the app ---------- */
function itemRow(o) {
  const t = now();
  return {
    id: o.id, kind: o.kind, poemId: o.poemId || null, title: o.title, description: '', poemTitle: '', poemStanzas: [],
    mime: o.mime, duration: o.duration, mediaKey: `items/${o.id}.${extFor(o.mime, o.name || '')}`, thumbKey: `thumbs/${o.id}.jpg`,
    publicMediaKey: null, publicThumbKey: null, status: 'draft', publishedAt: null, commentsEnabled: true, reactionsEnabled: true,
    createdAt: t, updatedAt: t, dirty: 1, remote: 0, blob: o.blob, thumbBlob: o.thumb, mediaPending: 1, thumbPending: 1,
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

// An uploaded audio or video file is saved as a draft first.
export async function createDraftFromFile(kind, file) {
  const problem = await checkSource(file, kind);
  if (problem) throw new Error(problem);
  const duration = await probeDuration(file);
  const title = file.name.replace(/\.[^.]+$/, '') || 'Untitled';
  let thumb;
  try { thumb = kind === 'video' ? await thumbFromVideo(file) : await thumbFromTitle(title); } catch { thumb = await thumbFromTitle(title); }
  const id = crypto.randomUUID();
  const mime = file.type || (kind === 'video' ? 'video/mp4' : 'audio/mpeg');
  await db.items.put(itemRow({ id, kind, title, mime, duration, blob: file, thumb, name: file.name }));
  syncSoon();
  return id;
}

// Uploads what is pending, copies it to the public bucket and flips the item to Published.
export async function publishItemNow(id) {
  if (!navigator.onLine) throw new Error('This needs internet.');
  await syncAndWait();
  let row = await db.items.get(id);
  if (!row) throw new Error('That item is gone.');
  if (row.mediaPending || row.thumbPending || row.dirty) throw new Error(getSyncState().error || 'The upload did not finish. Try again with a better connection.');
  const out = await publishItem(id, row.mediaKey, row.thumbKey);
  await db.items.update(id, {
    status: 'published', publishedAt: row.publishedAt || now(), publicMediaKey: out.publicMediaKey,
    publicThumbKey: out.publicThumbKey, ...(await snapshot(row.poemId)), updatedAt: now(), dirty: 1,
  });
  await syncAndWait();
  row = await db.items.get(id);
  if (row.dirty) throw new Error('The files are ready but the page did not update. Tap Publish again.');
}

/* ---------- list (the Studio tab) ---------- */
let listFilter = 'all';

export async function publishListView(nav) {
  const all = (await db.items.toArray()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const rows = all.filter((r) => (listFilter === 'published' ? r.status === 'published' : listFilter === 'drafts' ? r.status !== 'published' : true));
  const subs = new Map();
  const filters = h('div', { class: 'filters' }, [['all', 'All'], ['drafts', 'Drafts'], ['published', 'Published']].map(([k, l]) =>
    h('button', { class: 'fchip' + (listFilter === k ? ' on' : ''), type: 'button', onclick: () => { listFilter = k; nav.refresh(); } }, l)));
  const list = rows.length
    ? h('ul', { class: 'list' }, rows.map((r) => {
        const sub = h('div', { class: 'sub' }, `${r.kind}, ${fmtDur(r.duration)}, edited ${fmtDate(r.updatedAt)}${r.dirty ? ', waiting to sync' : ''}`);
        subs.set(r.id, sub);
        const thumb = r.thumbBlob ? withUrl(r.thumbBlob, h('img', { class: 'thumb', alt: '' })) : h('div', { class: 'thumb ph' });
        const end = r.status === 'published'
          ? h('span', { class: 'badge', 'data-status': r.status }, STATUS[r.status])
          : (() => {
              const btn = h('button', {
                class: 'btn small primary', type: 'button',
                onclick: async (e) => {
                  e.stopPropagation();
                  btn.disabled = true;
                  btn.textContent = 'Publishing…';
                  try { await publishItemNow(r.id); toast('Published.'); } catch (x) { toast(x.message || String(x)); }
                  nav.refresh();
                },
              }, 'Publish');
              return btn;
            })();
        return h('li', { class: 'item', onclick: () => nav.open(r.id) }, thumb,
          h('div', { class: 'grow' }, h('div', { class: 'title' }, r.title || 'Untitled'), h('div', { class: 'sub' }, STATUS[r.status] || r.status), sub), end);
      }))
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
      h('div', { class: 'row' }, live, h('button', { class: 'btn primary', onclick: () => nav.bake() }, 'Bake'))),
    filters, list, upload);
  if (navigator.onLine && rows.some((r) => r.status === 'published')) {
    sb.from('counters').select('*').then(({ data }) => {
      for (const c of data || []) {
        const sub = subs.get(c.item_id);
        const r = rows.find((x) => x.id === c.item_id);
        if (sub && r) sub.textContent = `${c.n_plays} plays, ${c.n_reactions} reactions, ${c.n_comments} comments`;
      }
    }).catch(() => {});
  }
  return el;
}

/* ---------- item editor ---------- */
export async function itemView(id, nav, prefill = {}) {
  const existing = await db.items.get(id);
  const poems = (await db.poems.toArray()).filter((p) => !p.deletedAt).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const baked = (await db.bakes.toArray()).filter((b) => !b.deletedAt && b.blob).sort(newest);
  const poemById = new Map(poems.map((p) => [p.id, p]));

  const title = h('input', { placeholder: 'Title', value: existing?.title || '', 'aria-label': 'Title' });
  const desc = h('textarea', { placeholder: 'Short description (optional)', rows: 3, 'aria-label': 'Description' });
  desc.value = existing?.description || '';
  const poemSel = h('select', { 'aria-label': 'Linked poem' }, h('option', { value: '' }, 'No poem text'), poems.map((p) => h('option', { value: p.id }, poemLabel(p))));
  poemSel.value = existing?.poemId || '';
  const comments = h('input', { type: 'checkbox', checked: existing ? existing.commentsEnabled : true });
  const reactions = h('input', { type: 'checkbox', checked: existing ? existing.reactionsEnabled : true });
  const details = h('div', { class: 'panel' },
    h('h3', {}, 'Details'), title, desc,
    h('label', {}, h('span', { class: 'muted small' }, 'Show this poem’s text on the page'), poemSel),
    h('label', { class: 'row check' }, comments, h('span', {}, 'Allow comments')),
    h('label', { class: 'row check' }, reactions, h('span', {}, 'Allow reactions')));

  const back = h('button', { class: 'btn small', onclick: () => nav.back() }, '← Studio');
  const root = h('section', { class: 'view' }, h('div', { class: 'toolbar' }, back));

  if (existing) {
    await existingUI(root, existing, { title, desc, poemSel, comments, reactions, details }, nav, snapshot);
    return root;
  }

  /* new item: choose source, thumbnail, details, then save as draft */
  let src = null;     // { kind, blob, mime, duration, name }
  let thumb = null;   // JPEG blob
  const srcInfo = h('p', { class: 'muted' }, 'Choose what to publish.');
  const preview = h('img', { class: 'thumb big', alt: 'Thumbnail preview', hidden: true });
  const showThumb = (blob) => { thumb = blob; withUrl(blob, preview); preview.hidden = false; };
  const bakeSel = h('select', { hidden: true, 'aria-label': 'Baked poem' }, baked.map((b) => {
    const p = poemById.get(b.poemId);
    return h('option', { value: b.id }, `${p ? poemLabel(p) : 'Poem'}, ${fmtDate(b.createdAt)}, ${fmtDur(b.duration)}`);
  }));
  const setSource = async (s) => {
    src = s;
    srcInfo.textContent = `${s.kind === 'video' ? 'Video' : 'Audio'}, ${fmtDur(s.duration)}, ${fmtSize(s.blob.size)}`;
    if (s.kind === 'video') { try { showThumb(await thumbFromVideo(s.blob)); } catch { /* choose another thumbnail */ } }
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

  const thumbPanel = h('div', { class: 'panel' }, h('h3', {}, '2. Thumbnail'),
    h('div', { class: 'seg' },
      h('button', { class: 'btn', onclick: async () => { const f = await pickFile('image/*'); if (f) try { showThumb(await thumbFromImage(f)); } catch (e) { toast(e.message); } } }, 'Upload image'),
      h('button', { class: 'btn', onclick: async () => { try { showThumb(await thumbFromTitle(title.value.trim() || 'Untitled')); } catch (e) { toast(e.message); } } }, 'From title'),
      h('button', { class: 'btn', onclick: async () => { if (src?.kind !== 'video') return toast('Pick a video first.'); try { showThumb(await thumbFromVideo(src.blob)); } catch (e) { toast(e.message); } } }, 'Video frame')),
    preview);

  const save = h('button', {
    class: 'btn primary wide',
    onclick: async () => {
      if (!src) return toast('Choose what to publish first.');
      if (!title.value.trim()) return toast('Give it a title.');
      save.disabled = true;
      try {
        const blob = thumb || await thumbFromTitle(title.value.trim());
        const t = now();
        await db.items.put({
          id, kind: src.kind, poemId: poemSel.value || null, title: title.value.trim(), description: desc.value.trim(),
          poemTitle: '', poemStanzas: [], mime: src.mime, duration: src.duration,
          mediaKey: `items/${id}.${extFor(src.mime, src.name)}`, thumbKey: `thumbs/${id}.jpg`,
          publicMediaKey: null, publicThumbKey: null, status: 'draft', publishedAt: null,
          commentsEnabled: comments.checked, reactionsEnabled: reactions.checked,
          createdAt: t, updatedAt: t, dirty: 1, remote: 0, blob: src.blob, thumbBlob: blob, mediaPending: 1, thumbPending: 1,
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

/* ---------- saved item ---------- */
async function existingUI(root, item, f, nav) {
  const id = item.id;
  const status = h('span', { class: 'badge', 'data-status': item.status }, STATUS[item.status]);
  const thumb = item.thumbBlob ? withUrl(item.thumbBlob, h('img', { class: 'thumb big', alt: 'Thumbnail' })) : h('div', { class: 'thumb big ph' });
  const play = playButton(async () => {
    const row = await db.items.get(id);
    if (row.blob) return row.blob;
    try { const b = await fetchMedia(row.mediaKey); await db.items.update(id, { blob: b }); return b; } catch { return null; }
  });
  const busyButtons = [];
  const guarded = (fn) => async () => {
    busyButtons.forEach((b) => { b.disabled = true; });
    try { await fn(); } catch (e) { toast(e.message || String(e)); }
    finally { nav.refresh(); }
  };
  const saveMeta = async () => {
    await db.items.update(id, {
      title: f.title.value.trim(), description: f.desc.value.trim(), poemId: f.poemSel.value || null,
      commentsEnabled: f.comments.checked, reactionsEnabled: f.reactions.checked, updatedAt: now(), dirty: 1,
    });
  };
  const needNet = () => { if (!navigator.onLine) throw new Error('This needs internet.'); };

  const publish = h('button', { class: 'btn primary', onclick: guarded(async () => {
    needNet();
    await saveMeta();
    await publishItemNow(id);
    toast('Published.');
  }) }, item.status === 'published' ? 'Update and republish' : 'Publish');

  const unpublish = h('button', { class: 'btn', onclick: guarded(async () => {
    needNet();
    if (!confirm('Unpublish? Listeners lose access. Reactions and comments are kept.')) return;
    await unpublishItem(id);
    await db.items.update(id, { status: 'unpublished', publicMediaKey: null, publicThumbKey: null, updatedAt: now(), dirty: 1 });
    await syncAndWait();
    toast('Unpublished.');
  }) }, 'Unpublish');

  const del = h('button', { class: 'btn danger', onclick: guarded(async () => {
    const row = await db.items.get(id);
    if (row.remote) {
      needNet();
      if (!confirm('Delete this item completely? Its files, reactions and comments are removed for good.')) return;
      await deleteItemFiles(id);
      const { error } = await sb.from('published_items').delete().eq('id', id);
      if (error) throw error;
    } else if (!confirm('Delete this draft?')) return;
    await db.items.delete(id);
    await db.uploads.delete(row.mediaKey);
    await db.uploads.delete(row.thumbKey);
    nav.back();
    toast('Deleted.');
  }) }, 'Delete');

  const saveBtn = h('button', { class: 'btn', onclick: guarded(async () => { await saveMeta(); syncSoon(); toast('Saved.'); }) }, 'Save changes');
  const refreshText = h('button', { class: 'btn', onclick: guarded(async () => {
    await db.items.update(id, { ...(await snapshot(f.poemSel.value || null)), updatedAt: now(), dirty: 1 });
    syncSoon();
    toast('Poem text will update on the public page.');
  }) }, 'Refresh poem text');
  busyButtons.push(publish, unpublish, del, saveBtn, refreshText);

  const actions = h('div', { class: 'panel' }, h('h3', {}, 'Actions'),
    h('div', { class: 'seg' }, ...(item.status === 'published' ? [publish, unpublish, refreshText] : [publish]), saveBtn),
    item.mediaPending || item.thumbPending ? h('p', { class: 'muted small' }, 'Files are waiting to upload.') : null,
    del);

  root.append(
    h('div', { class: 'row top' }, thumb, h('div', { class: 'grow' }, h('h2', {}, item.title || 'Untitled'), status,
      h('div', { class: 'sub' }, `${item.kind}, ${fmtDur(item.duration)}`)), play),
    f.details, actions);

  if (item.status === 'published') {
    const link = `${location.origin}/p/${id}`;
    root.append(h('div', { class: 'panel' }, h('h3', {}, 'Share link'),
      h('input', { value: link, readonly: true, 'aria-label': 'Share link', onfocus: (e) => e.target.select() }),
      h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch { toast('Press and hold the link to copy it.'); } } }, 'Copy link')));
    const box = h('div', { class: 'panel' }, h('h3', {}, 'Reactions and comments'), h('p', { class: 'muted small' }, 'Loading…'));
    root.append(box);
    loadEngagement(box, id);
  }
}

async function loadEngagement(box, id) {
  if (!navigator.onLine) { box.querySelector('p').textContent = 'Connect to see reactions and comments.'; return; }
  const reload = () => loadEngagement(box, id);
  try {
    const [c, cm] = await Promise.all([
      sb.from('counters').select('*').eq('item_id', id).maybeSingle(),
      sb.from('comments').select('*').eq('item_id', id).order('created_at', { ascending: false }).limit(100),
    ]);
    if (c.error) throw c.error;
    if (cm.error) throw cm.error;
    const n = c.data || {};
    const act = (label, fn, cls = '') => h('button', { class: 'btn small ' + cls, onclick: async () => { const { error } = await fn(); if (error) toast(error.message); else reload(); } }, label);
    box.replaceChildren(
      h('h3', {}, 'Reactions and comments'),
      h('p', {}, `${n.n_plays || 0} plays, ${n.n_reactions || 0} reactions (love ${n.n_love || 0}, like ${n.n_like || 0}, emotional ${n.n_emotional || 0}, funny ${n.n_funny || 0}), ${n.n_comments || 0} comments`),
      cm.data.length
        ? h('ul', { class: 'list' }, cm.data.map((x) => h('li', { class: 'item col' },
            h('div', {}, h('strong', {}, x.nickname), h('span', { class: 'sub' }, ` ${fmtDate(x.created_at)}${x.hidden ? ', hidden' : ''}`)),
            h('div', {}, x.body),
            h('div', { class: 'seg' },
              act(x.hidden ? 'Show' : 'Hide', () => sb.from('comments').update({ hidden: !x.hidden }).eq('id', x.id)),
              act('Delete', () => sb.from('comments').delete().eq('id', x.id), 'danger'),
              act('Block viewer', () => sb.from('viewer_profiles').upsert({ user_id: x.user_id, nickname: x.nickname, blocked: true }), 'danger')))))
        : h('p', { class: 'muted small' }, 'No comments yet.'));
  } catch (e) {
    box.querySelector('p').textContent = 'Could not load: ' + (e.message || e);
  }
}
