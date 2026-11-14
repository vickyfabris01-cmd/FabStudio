// Baking: read a poem while the microphone and the poem's background tune are recorded together,
// then preview the result and, if needed, change the tune volume.
import { db, uid, now } from './db.js';
import { getBlob, syncSoon } from './sync.js';
import { startCapture } from './recorder.js';
import { LiveMix, BAKE_TUNE_VOLUME, loadRemix, Remix, rebake } from './mixer.js';
import { createDraftFromBake, syncDraftFromBake } from './publish.js';
import { h, fmtDur, fmtDate, extFor, toast, openModal } from './ui.js';

const prefs = () => {
  try { return { deviceId: '', raw: false, ...JSON.parse(localStorage.getItem('fabstudio.prefs') || '{}') }; }
  catch { return { deviceId: '', raw: false }; }
};
const poemName = (p) => p.title || (p.stanzas?.[0] || '').split('\n')[0] || 'Untitled';

/* ---------- step 1: choose a poem ---------- */
async function pickPoemView(nav) {
  const rows = (await db.poems.toArray()).filter((p) => !p.deletedAt).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, h('button', { class: 'btn small', onclick: () => nav.back() }, '← Studio')),
    h('h2', {}, 'Bake a poem'),
    h('p', { class: 'muted small' }, 'Pick the poem to read. Use headphones so the tune is not recorded twice.'),
    rows.length
      ? h('ul', { class: 'list' }, rows.map((p) => h('li', { class: 'item', onclick: () => nav.pickBake(p.id) },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, poemName(p)), h('div', { class: 'sub' }, `${p.stanzas?.length || 0} stanzas`)))))
      : h('p', { class: 'empty' }, 'No poems yet. Write one in the Poems tab first.'));
}

/* ---------- step 2: the baking page ---------- */
export async function bakerView({ poemId, nav }) {
  if (!poemId) return pickPoemView(nav);
  const poem = await db.poems.get(poemId);
  if (!poem || poem.deletedAt) { nav.back(); return h('section', { class: 'view' }); }

  const tuneRow = poem.tuneId ? await db.tunes.get(poem.tuneId) : null;
  const tune = tuneRow && !tuneRow.deletedAt ? tuneRow : null;
  let tuneBlob = null;
  if (tune) {
    tuneBlob = await getBlob('tunes', tune);
    if (!tuneBlob) toast('The tune is not on this device yet. Connect to download it. Baking without it for now.');
  }
  const mix = new LiveMix(tuneBlob, BAKE_TUNE_VOLUME);
  try { await mix.load(); } catch { mix.tuneBuf = null; toast('The tune could not be read. Baking without it.'); }
  const hasTune = !!mix.tuneBuf;

  let stream = null;
  let session = null;
  let recording = false;
  let capDelay = 0;
  let t0 = 0;
  let tick = null;

  const status = h('div', { class: 'bake-status' }, 'Ready');
  const tuneBtn = h('button', { class: 'btn', type: 'button', hidden: !hasTune }, 'Start tune');
  const micBtn = h('button', { class: 'btn', type: 'button' }, 'Start mic');
  const stopBtn = h('button', { class: 'btn primary', type: 'button', hidden: true }, 'Stop');

  const paint = () => {
    if (!recording) { status.textContent = hasTune ? `Ready. Tune: ${tune.title || 'Untitled tune'}` : 'Ready. No background tune for this poem.'; return; }
    const tuneState = !hasTune ? '' : mix.tunePlaying ? ', tune playing' : mix.tuneOffset != null ? ', tune finished' : ', tune not started';
    status.textContent = `● Recording ${fmtDur((Date.now() - t0) / 1000)}${tuneState}`;
    micBtn.textContent = 'Mic on';
    micBtn.classList.add('on');
    stopBtn.hidden = false;
    tuneBtn.hidden = !hasTune || mix.tuneOffset != null;
  };

  const ensureRecording = async () => {
    if (recording) return true;
    const p = prefs();
    const audio = { echoCancellation: !p.raw, noiseSuppression: !p.raw, autoGainControl: !p.raw };
    if (p.deviceId) audio.deviceId = { exact: p.deviceId };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) { toast('Microphone unavailable: ' + (e.message || e.name)); return false; }
    try {
      await mix.begin(stream);
      session = await startCapture({ poemId, stream, deviceId: p.deviceId, raw: p.raw });
    } catch (e) {
      stream.getTracks().forEach((tr) => tr.stop());
      toast('Could not start recording: ' + (e.message || e));
      return false;
    }
    capDelay = mix.ctx.currentTime - mix.t0;
    recording = true;
    t0 = Date.now();
    tick = setInterval(paint, 500);
    paint();
    return true;
  };

  micBtn.onclick = () => { if (!recording) ensureRecording(); };
  tuneBtn.onclick = async () => {
    if (!(await ensureRecording())) return;
    mix.startTune();
    paint();
  };
  mix.onTuneEnd = () => paint();

  stopBtn.onclick = async () => {
    clearInterval(tick);
    stopBtn.disabled = true;
    status.textContent = 'Saving…';
    let out = null;
    let capId = null;
    try {
      out = await mix.finish();
      capId = await session.stop();
    } catch (e) {
      toast('Saving failed: ' + (e.message || e));
    }
    stream?.getTracks().forEach((tr) => tr.stop());
    recording = false;
    if (!out || !out.blob.size) { toast('Nothing was recorded.'); return nav.back(); }
    const cap = capId ? await db.captures.get(capId) : null;
    const bid = uid();
    const t = now();
    const tuneUsed = out.tuneOffset != null && tune;
    const bake = {
      id: bid, poemId, captureId: cap ? capId : null, tuneId: tuneUsed ? tune.id : null, tuneVolume: BAKE_TUNE_VOLUME,
      tuneOffset: tuneUsed ? Math.max(0, out.tuneOffset - capDelay) : null,
      mime: out.mime, duration: out.duration, blob: out.blob, r2Key: `bakes/${bid}.${extFor(out.mime)}`,
      createdAt: t, updatedAt: t, dirty: 1, blobPending: 1,
    };
    await db.bakes.put(bake);
    try { await createDraftFromBake(bake); } catch (e) { toast('Baked, but the Studio draft could not be made: ' + (e.message || e)); }
    syncSoon();
    openBakeModal(bid, { onDone: () => nav.back() });
  };

  const back = h('button', {
    class: 'btn small', type: 'button',
    onclick: () => {
      if (recording) return toast('Stop the recording first.');
      mix.dispose();
      nav.back();
    },
  }, '← Studio');

  paint();
  const el = h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, back, h('span', { class: 'status' }, 'Baking')),
    h('h2', {}, poemName(poem)),
    h('div', { class: 'bake-text' }, (poem.stanzas || []).join('\n\n') || 'This poem has no text yet.'),
    h('div', { class: 'spacer' }),
    h('div', { class: 'bakebar' },
      status,
      h('div', { class: 'seg' }, tuneBtn, micBtn, stopBtn),
      h('p', { class: 'muted small' }, 'Tune plays once at half volume. Your voice keeps recording until you tap Stop. Use headphones.')));
  el._dispose = () => { if (!recording) mix.dispose(); };
  return el;
}

/* ---------- the preview modal ---------- */
export async function openBakeModal(bakeId, { onDone, onChange } = {}) {
  let bake = await db.bakes.get(bakeId);
  if (!bake || bake.deletedAt) return toast('That file is gone.');
  const poem = bake.poemId ? await db.poems.get(bake.poemId) : null;
  const name = poem && !poem.deletedAt ? poemName(poem) : 'Baked poem';

  let player = null;
  let remix = null; // { m, offset } when the original voice and tune are on this device
  let volume = bake.tuneVolume ?? BAKE_TUNE_VOLUME;
  let savedVolume = volume;
  let busy = false;
  let poll = null;

  const playBtn = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Play' }, '▶');
  const seek = h('input', { type: 'range', min: 0, max: Math.max(1, Math.round(bake.duration || 1)), value: 0, step: 1, 'aria-label': 'Position' });
  const time = h('span', { class: 'sub' }, `0:00 / ${fmtDur(bake.duration)}`);
  const volRange = h('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(volume * 100), 'aria-label': 'Background volume', hidden: true });
  const volLabel = h('span', { class: 'sub' }, '');
  const volNote = h('p', { class: 'muted small' }, 'Loading the original tracks…');
  const saveBtn = h('button', { class: 'btn primary', type: 'button', hidden: true }, 'Save volume');
  const progress = h('progress', { max: 1, value: 0, hidden: true });
  const doneBtn = h('button', { class: 'btn', type: 'button' }, 'Done');

  const m = openModal(
    h('h3', {}, name),
    h('p', { class: 'muted small' }, `Baked audio, ${fmtDur(bake.duration)}, ${fmtDate(bake.createdAt)}. It is in Studio as a draft.`),
    h('div', { class: 'row' }, playBtn, h('div', { class: 'grow' }, seek), time),
    h('div', { class: 'stack' }, h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Background volume'), volLabel), volRange, volNote, saveBtn, progress),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, doneBtn));

  const dispose = () => {
    clearInterval(poll);
    try { player?.dispose(); } catch { /* ignore */ }
    try { remix?.m.ctx.close(); } catch { /* ignore */ }
  };
  m.box.addEventListener('modal-close', () => { dispose(); onDone?.(); });
  doneBtn.onclick = () => { if (busy) return toast('Saving. Keep this open.'); m.close(); };

  const paintPos = () => {
    if (!player) return;
    const pos = player.pos();
    if (document.activeElement !== seek) seek.value = Math.round(pos);
    time.textContent = `${fmtDur(pos)} / ${fmtDur(player.duration)}`;
    playBtn.textContent = player.playing ? '■' : '▶';
  };
  poll = setInterval(paintPos, 250);
  const showVol = () => { volLabel.textContent = Math.round(volume * 100) + '%'; saveBtn.hidden = !remix || Math.abs(volume - savedVolume) < 0.005; };
  showVol();

  const filePlayer = (blob) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    const api = {
      get duration() { return Number.isFinite(a.duration) && a.duration ? a.duration : bake.duration; },
      get playing() { return !a.paused && !a.ended; },
      play(from) { if (from != null) a.currentTime = from; return a.play(); },
      pause() { a.pause(); },
      seekTo(sec) { a.currentTime = sec; },
      pos() { return a.currentTime; },
      dispose() { a.pause(); URL.revokeObjectURL(url); },
    };
    a.onended = () => { a.currentTime = 0; paintPos(); };
    return api;
  };
  const remixPlayer = (rm) => {
    const r = new Remix(rm.m, rm.offset, volume, null);
    r.onEnd = () => paintPos();
    return {
      r,
      get duration() { return r.duration; },
      get playing() { return r.playing; },
      play(from) { rm.m.ctx.resume(); r.start(from ?? r.pos()); },
      pause() { r.halt(); },
      seekTo(sec) { if (r.playing) r.start(sec); else r.last = sec; },
      pos() { return r.pos(); },
      setVolume(v) { r.setVolume(v); },
      dispose() { r.halt(); },
    };
  };

  // Start with the saved file itself, so what you hear is what will be published.
  const blob = await getBlob('bakes', bake);
  if (blob) player = filePlayer(blob);
  else toast('This file is not on this device yet. Connect to the internet to play it.');

  playBtn.onclick = async () => {
    if (!player) return toast('Nothing to play yet.');
    if (player.playing) player.pause(); else await player.play();
    paintPos();
  };
  seek.oninput = () => { player?.seekTo(Number(seek.value)); paintPos(); };

  // Can the volume change? Only if the original voice and tune are here.
  (async () => {
    try {
      const cap = bake.captureId ? await db.captures.get(bake.captureId) : null;
      const tuneRow = bake.tuneId ? await db.tunes.get(bake.tuneId) : null;
      if (!bake.tuneId || bake.tuneOffset == null) { volNote.textContent = 'This recording has no background tune, so there is no volume to change.'; return; }
      if (!cap || cap.deletedAt || !tuneRow || tuneRow.deletedAt) { volNote.textContent = 'The original voice or tune was deleted, so the volume cannot be changed.'; return; }
      const [voice, tuneBlob] = [await getBlob('captures', cap), await getBlob('tunes', tuneRow)];
      if (!voice || !tuneBlob) { volNote.textContent = 'The original voice or tune is not on this device yet. Connect to the internet to change the volume.'; return; }
      remix = { m: await loadRemix(voice, tuneBlob), offset: bake.tuneOffset };
      volRange.hidden = false;
      volNote.textContent = 'Lower the tune if it covers your words. Moving the slider plays the mix live. Save to apply it to the file.';
      showVol();
    } catch {
      volNote.textContent = 'The original tracks could not be read, so the volume cannot be changed.';
    }
  })();

  volRange.oninput = () => {
    volume = Number(volRange.value) / 100;
    if (remix && !(player && player.r)) {
      const wasPlaying = player?.playing;
      const at = player ? player.pos() : 0;
      player?.dispose();
      player = remixPlayer(remix);
      player.seekTo(at);
      if (wasPlaying) player.play(at);
    }
    player?.setVolume?.(volume);
    showVol();
  };

  saveBtn.onclick = async () => {
    if (!remix || busy) return;
    busy = true;
    player?.pause();
    saveBtn.disabled = true;
    progress.hidden = false;
    progress.value = 0;
    toast('Saving takes as long as the recording. Keep this open.');
    try {
      const out = await rebake(remix.m, remix.offset, volume, (p) => { progress.value = p; });
      await db.bakes.update(bake.id, { blob: out.blob, mime: out.mime, duration: out.duration, tuneVolume: volume, updatedAt: now(), dirty: 1, blobPending: 1 });
      await syncDraftFromBake(bake.id);
      bake = await db.bakes.get(bake.id);
      savedVolume = volume;
      syncSoon();
      toast('Saved.');
      onChange?.();
    } catch (e) {
      toast('Saving failed: ' + (e.message || e));
    } finally {
      busy = false;
      saveBtn.disabled = false;
      progress.hidden = true;
      showVol();
    }
  };
}
