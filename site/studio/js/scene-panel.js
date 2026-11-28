// The "Screen settings" card (the animated screen) on the page of an audio item:
//   - switch the animated screen on, choose its background picture, preview any moment, use a frame as the thumbnail
//   - lyrics: open the timing editor, choose the animation, switch "Show lyrics" on or off
// The page passes in what it already has (the item, the database helpers), so this file does not import the page.
import { h, toast, fmtDur } from './ui.js';
import { drawScene, defaultScene, LYRIC_ANIMS, SCENE_W, SCENE_H } from '../../shared/scene.js';
import { pickThumbnail } from './thumb-picker.js';
import { openLyricsEditor } from './lyrics-editor.js';

const wide = window.matchMedia('(min-width: 900px)');

// Helpers for the settings panel.
function helpers(ctx) {
  const { id, db, now, syncSoon, fetchMedia, changed } = ctx;
  const update = async (patch, republish = false) => {
    await db.items.update(id, { ...patch, updatedAt: now(), dirty: 1, ...(republish && ctx.item.status === 'published' ? { needsRepublish: 1 } : {}) });
    syncSoon();
    await changed();
  };
  const audioBlob = async () => {
    const cur = await db.items.get(id);
    if (cur.blob) return cur.blob;
    if (!navigator.onLine) throw new Error('This needs internet.');
    return fetchMedia(cur.mediaKey);
  };
  return { update, audioBlob };
}

// ctx: { id, item, db, now, syncSoon, fetchMedia, putAlt, changed() }
export function scenePanel(ctx) {
  const { id, db } = ctx;
  const item = ctx.item;
  const scene = item.scene || null;
  const box = h('div', { class: 'panel' });
  const { update, audioBlob } = helpers(ctx);

  // ---------- off: one button
  if (!scene) {
    const on = h('button', { class: 'btn', type: 'button' }, 'Use the animated screen');
    on.onclick = () => update({ scene: defaultScene() }, true);
    box.append(h('h3', {}, 'Screen settings'),
      h('p', { class: 'muted small' }, 'Instead of a still picture, listeners see a moving screen: your background picture, the title, sound bars that follow the music and, if you add them, the lyrics. It adds no download for listeners.'), on);
    return box;
  }

  // ---------- on: preview
  const cv = h('canvas', { class: 'sc-preview', width: SCENE_W / 2, height: SCENE_H / 2, 'aria-label': 'Preview of the animated screen' });
  const dur = item.duration || 1;
  const at = h('input', { type: 'range', min: '0', max: String(dur), step: '0.1', value: '0', 'aria-label': 'Moment to preview' });
  const atLabel = h('span', { class: 'muted small' }, '0:00');
  let bgImg = null;
  let markImg = null;
  const lyrics = Array.isArray(item.lyricsDraft) ? item.lyricsDraft.filter((r) => r.s != null).map((r) => ({ s: r.s, e: r.e, t: r.t })) : (item.lyrics || []);
  const paint = () => {
    const c = cv.getContext('2d');
    c.save();
    c.scale(cv.width / SCENE_W, cv.height / SCENE_H);
    const t = Number(at.value);
    drawScene(c, SCENE_W, SCENE_H, { t, bars: Array.from({ length: 32 }, (_, i) => 0.15 + 0.5 * Math.abs(Math.sin(t * 2 + i * 0.5))), title: item.title, bg: bgImg, mark: markImg, lyrics, anim: scene.lyricAnim });
    c.restore();
    atLabel.textContent = fmtDur(t);
  };
  at.oninput = paint;
  (async () => {
    try { markImg = await createImageBitmap(await (await fetch('/studio/icons/mark.png')).blob()); } catch { /* no logo */ }
    if (item.bgBlob) bgImg = await createImageBitmap(item.bgBlob).catch(() => null);
    paint();
  })();

  // ---------- background picture
  const pickBg = h('button', { class: 'btn small', type: 'button' }, item.bgKey ? 'Change background picture' : 'Choose background picture');
  pickBg.onclick = async () => {
    const r = await pickThumbnail({ imageOnly: true, heading: 'Background picture' });
    if (!r) return;
    await update({ bgBlob: r.blob, bgKey: `thumbs/${id}.bg.jpg`, bgPending: 1, publicBgKey: null, scene: { ...scene } }, true);
  };
  const dropBg = item.bgKey ? h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
    await update({ bgBlob: undefined, bgKey: null, bgPending: 0, publicBgKey: null, scene: { ...scene } }, true);
  } }, 'Remove background picture') : null;

  // ---------- use a frame as the thumbnail
  const useFrame = h('button', { class: 'btn small', type: 'button' }, 'Use this moment as the thumbnail');
  useFrame.onclick = async () => {
    const out = document.createElement('canvas');
    out.width = 1280; out.height = 720;
    drawScene(out.getContext('2d'), 1280, 720, { t: Number(at.value), bars: new Array(32).fill(0.1), title: item.title, bg: bgImg, mark: markImg, lyrics, anim: scene.lyricAnim });
    const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.88));
    await update({ thumbBlob: blob, thumbPending: 1, thumbKind: 'scene' }, true);
    toast('Thumbnail updated.');
  };

  // ---------- lyrics
  const animSel = h('select', { 'aria-label': 'Lyrics animation' }, LYRIC_ANIMS.map(([v, l]) => h('option', { value: v }, l)));
  animSel.value = scene.lyricAnim || 'slide';
  animSel.onchange = () => update({ scene: { ...scene, lyricAnim: animSel.value } }, true);
  const nTimed = (item.lyrics || []).length || (item.lyricsDraft || []).filter((r) => r.s != null).length;
  const editLyrics = h('button', { class: 'btn small', type: 'button' }, nTimed ? 'Edit lyrics timing' : 'Add lyrics');
  editLyrics.onclick = async () => {
    editLyrics.disabled = true;
    try {
      const cur = await db.items.get(id);
      let text = '';
      if (!cur.lyricsDraft?.length && cur.poemId) {
        const poem = await db.poems.get(cur.poemId);
        text = (poem?.stanzas || []).join('\n\n');
      }
      await openLyricsEditor({
        title: cur.title, audio: await audioBlob(), rows: cur.lyricsDraft || null, text, anim: scene.lyricAnim, bg: cur.bgBlob || null,
        onSave: ({ lyrics: timed, draft }) => update({ lyrics: timed.length ? timed : null, lyricsDraft: draft, showLyrics: timed.length ? item.showLyrics !== false : false }, true),
      });
    } catch (e) { toast(e.message || String(e)); }
    editLyrics.disabled = false;
  };
  const showCb = h('input', { type: 'checkbox', checked: !!item.showLyrics && nTimed > 0, disabled: !nTimed });
  showCb.onchange = () => update({ showLyrics: showCb.checked });

  const off = h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
    if (!confirm('Go back to the still thumbnail with simple bars? Lyrics stay saved.')) return;
    await update({ scene: null, showLyrics: false }, true);
  } }, 'Turn off animated screen');

  box.append(h('h3', {}, 'Screen settings'), cv,
    h('div', { class: 'row' }, at, atLabel),
    h('div', { class: 'stack' }, pickBg, dropBg, useFrame),
    h('h4', {}, 'Lyrics'),
    h('p', { class: 'muted small' }, nTimed ? `${nTimed} timed line${nTimed === 1 ? '' : 's'}. In quiet moments no lyric shows.` : 'Not every item needs lyrics. Add them to show timed lines on the screen.'),
    h('div', { class: 'row sc-row' }, h('span', { class: 'muted small' }, 'Animation'), animSel),
    h('div', { class: 'stack' }, editLyrics),
    h('label', { class: 'row check' }, showCb, h('span', {}, 'Show lyrics to listeners')),
    h('div', { class: 'stack' }, off));
  return box;
}