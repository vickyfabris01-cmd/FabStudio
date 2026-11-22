// Baking: the same console as Live. You read the poem, play its tune through the soundcard, and the soundcard's
// mixed sound is recorded. The take lands in the right-hand pane as a draft you can play and publish; Done closes it.
import { db, uid, now } from './db.js';
import { getBlob, syncSoon } from './sync.js';
import { startCapture } from './recorder.js';
import { BAKE_TUNE_VOLUME, loadRemix, Remix, rebake } from './mixer.js';
import { createDraftFromBake, syncDraftFromBake, publishItemNow } from './publish.js';
import { onPublishJobs, jobFor } from './publisher.js';
import { h, fmtDur, fmtDate, extFor, toast, openModal } from './ui.js';
import { LiveAudio, listInputs } from './live-audio.js';
import { deck, listOutputs, canChooseOutput } from './console/deck.js';
import { sourceControl, source } from './console/source.js';
import { readingPane } from './console/reading.js';
import { engine } from './live-engine.js';

// Baking is done on a laptop (a screen at least 900px wide), where the sound card gives a proper mix. A phone can
// still publish, edit and delete everything that was baked.
const isLaptop = () => window.matchMedia('(min-width: 900px)').matches;
function laptopOnlyView(nav) {
  return h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, h('button', { class: 'btn small', type: 'button', onclick: () => nav.back() }, '← Studio')),
    h('h2', {}, 'Bake on a laptop'),
    h('p', { class: 'muted' }, 'Baking records the mix from your sound card, and needs a laptop for a good result. Open the Studio on your laptop to bake. Baked audio already made shows up here, and you can publish, edit or delete it from your phone.'));
}
const bakePrefs = () => { try { return JSON.parse(localStorage.getItem('fabstudio.bake') || '{}'); } catch { return {}; } };
const saveBakePrefs = (p) => { try { localStorage.setItem('fabstudio.bake', JSON.stringify({ ...bakePrefs(), ...p })); } catch { /* ignore */ } };
const poemName = (p) => p.title || (p.stanzas?.[0] || '').split('\n')[0] || 'Untitled';
const clock = (s) => { s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/* ---------- the baking console ---------- */
// Same pieces as the live console: header row, sound strip, reading pane (poem, tune, play row) and the right-hand
// pane. Here the right-hand pane starts empty and shows the take once it is saved.
export async function bakerView({ poemId, nav }) {
  if (!isLaptop()) return laptopOnlyView(nav);
  if (engine.active) { toast('A live is on air. End it before baking.'); nav.back(); return h('section', { class: 'view' }); }

  const root = h('div', { class: 'console baking-console' });
  const src = sourceControl();                 // the same Poem picker as the live console
  src.el.querySelector('.src-mode option[value="music"]')?.remove();   // baking is for poems
  source.setMode('poem');
  source.setPoem(poemId || '');                // nothing is loaded until you pick it
  const reading = await readingPane();

  /* ----- state ----- */
  const audioIn = new LiveAudio();
  let armed = false;
  let session = null; let recording = false; let saving = false; let starting = null;
  let t0 = 0; let recPoemId = '';
  let take = null;                             // { bakeId, itemId, title, duration, blob }
  let takeAudio = null; let takeUrl = '';
  const offs = [];

  /* ----- header: back, poem picker, status, clock, record, done ----- */
  const status = h('span', { class: 'badge' });
  const timer = h('b', { class: 'c-clock' });
  const rec = h('button', { class: 'btn small', type: 'button' });
  const done = h('button', { class: 'btn small primary', type: 'button', hidden: true }, 'Done');
  const back = h('button', { class: 'btn small', type: 'button', onclick: () => {
    if (recording || saving) return toast('Stop the recording first.');
    leave();
  } }, '‹ Studio');
  const head = h('div', { class: 'card c-head' },
    h('div', { class: 'row c-headrow' }, back, h('div', { class: 'grow' }, src.el), status, timer, rec, done));
  const barTitle = h('span', { class: 'bar-title', style: 'cursor:default' });

  /* ----- sound strip: level, gain, volume, input, output ----- */
  const inSel = h('select', { 'aria-label': 'Audio input' });
  const outSel = h('select', { 'aria-label': 'Audio output' });
  const meterFill = h('div', { class: 'meter-fill' });
  const soundMsg = h('p', { class: 'small error' });
  const gain = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: String(bakePrefs().gain ?? 1), 'aria-label': 'Input gain' });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: deck.s.volume, 'aria-label': 'Volume of the poem tune' });
  const volText = h('span', { class: 'small muted c-voltxt' }, '100%');
  gain.oninput = () => { audioIn.setGain(Number(gain.value)); saveBakePrefs({ gain: Number(gain.value) }); };
  vol.oninput = () => deck.setVolume(Number(vol.value));
  const fillDevices = async () => {
    const ins = await listInputs();
    inSel.replaceChildren(h('option', { value: '' }, 'Default input'), ...ins.map((i) => h('option', { value: i.id }, i.label)));
    inSel.value = ins.some((i) => i.id === bakePrefs().inId) ? bakePrefs().inId : '';
    const outs = await listOutputs();
    outSel.replaceChildren(h('option', { value: '' }, 'Default output'), ...outs.filter((o) => o.id !== 'default').map((o) => h('option', { value: o.id }, o.label)));
    outSel.value = outs.some((o) => o.id === deck.s.outId) ? deck.s.outId : '';
  };
  const arm = async (deviceId) => {
    try {
      if (!armed) { await audioIn.start({ deviceId, gain: Number(gain.value) }); armed = true; audioIn.onLost = () => { soundMsg.textContent = 'The input disappeared. Choose it again.'; }; }
      else await audioIn.useDevice(deviceId);
      soundMsg.textContent = '';
      saveBakePrefs({ inId: deviceId });
      await fillDevices();
      return true;
    } catch (e) { soundMsg.textContent = e.name === 'NotAllowedError' ? 'The browser blocked the microphone.' : (e.message || String(e)); return false; }
  };
  inSel.onchange = () => arm(inSel.value);
  outSel.onchange = async () => { try { await deck.setOutput(outSel.value); soundMsg.textContent = ''; } catch (e) { soundMsg.textContent = 'Could not use that output: ' + (e.message || e.name); } };
  outSel.disabled = !canChooseOutput();
  if (outSel.disabled) outSel.title = 'This browser cannot choose an output. Use Chrome or Edge.';
  const sound = h('section', { class: 'card c-sound' },
    h('div', { class: 'row c-soundrow' },
      h('span', { class: 'small muted' }, 'Level'), h('div', { class: 'meter c-meter' }, meterFill),
      h('span', { class: 'small muted' }, 'Gain'), h('div', { style: 'width:100px' }, gain),
      h('span', { class: 'small muted' }, 'Vol'), h('div', { style: 'width:100px' }, vol), volText,
      h('span', { class: 'small muted' }, 'In'), h('div', { class: 'c-sel' }, inSel),
      h('span', { class: 'small muted' }, 'Out'), h('div', { class: 'c-sel' }, outSel)),
    soundMsg);
  const meterTimer = setInterval(() => {
    const lv = armed ? audioIn.level() : 0;
    meterFill.style.width = Math.round(lv * 100) + '%';
    meterFill.classList.toggle('hot', lv > 0.92);
  }, 100);

  /* ----- right-hand pane: the chat pane, empty and greyed; the take appears in it once saved ----- */
  const feed = h('div', { class: 'chat-list', role: 'log' });
  const chatIn = h('input', { placeholder: 'Say something as the host…', maxlength: 300, 'aria-label': 'Message', disabled: true });
  const sendBtn = h('button', { class: 'btn small', type: 'button', disabled: true }, 'Send');
  const composer = h('div', { class: 'row' }, h('div', { class: 'grow' }, chatIn), sendBtn);
  const chat = h('section', { class: 'card c-chat' },
    h('div', { class: 'row c-tabs' }, h('button', { class: 'tab on', type: 'button' }, 'Chats'), h('span', { class: 'grow' })),
    feed, composer);

  /* ----- the saved take: play, status, publish ----- */
  function showTake() {
    const playBtn = h('button', { class: 'btn small rd-play', type: 'button', 'aria-label': 'Play' }, '▶');
    const seek = h('input', { type: 'range', min: 0, max: Math.max(1, Math.round(take.duration || 1)), value: 0, step: 1, 'aria-label': 'Position', class: 'rd-seek' });
    const time = h('span', { class: 'muted small rd-time' }, `0:00 / ${fmtDur(take.duration)}`);
    const badge = h('span', { class: 'badge' });
    const pubBtn = h('button', { class: 'btn primary small', type: 'button' }, 'Publish');
    const note = h('p', { class: 'small error bk-note' });
    takeUrl = URL.createObjectURL(take.blob);
    takeAudio = new Audio(takeUrl);
    const paintPos = () => {
      const a = takeAudio; if (!a) return;
      const dur = Number.isFinite(a.duration) && a.duration ? a.duration : take.duration;
      if (document.activeElement !== seek) seek.value = Math.round(a.currentTime);
      time.textContent = `${fmtDur(a.currentTime)} / ${fmtDur(dur)}`;
      playBtn.textContent = a.paused ? '▶' : '❚❚';
      playBtn.setAttribute('aria-label', a.paused ? 'Play' : 'Pause');
    };
    takeAudio.ontimeupdate = paintPos; takeAudio.onended = () => { takeAudio.currentTime = 0; paintPos(); }; takeAudio.onpause = paintPos; takeAudio.onplay = paintPos;
    playBtn.onclick = () => { if (takeAudio.paused) { deck.pause(); takeAudio.play().catch(() => toast('The browser did not start the audio.')); } else takeAudio.pause(); };
    seek.oninput = () => { takeAudio.currentTime = Number(seek.value); paintPos(); };

    const refresh = async () => {
      const row = await db.items.get(take.itemId);
      const job = jobFor(take.itemId);
      const busy = !!job && ['queued', 'running', 'waiting'].includes(job.state);
      const isPub = row?.status === 'published';
      badge.textContent = isPub ? 'Published' : busy ? `${job.label || 'Publishing'} ${job.pct || 0}%` : 'Draft';
      badge.dataset.status = isPub ? 'published' : 'draft';
      pubBtn.hidden = isPub;
      pubBtn.disabled = busy;
      note.textContent = !busy && !isPub && job?.error ? job.error : '';
    };
    pubBtn.onclick = async () => {
      pubBtn.disabled = true; note.textContent = '';
      try { await publishItemNow(take.itemId, take.title); } catch (e) { note.textContent = e.message || String(e); }
      refresh();
    };
    offs.push(onPublishJobs((j) => { if (j.id === take.itemId) refresh(); }));
    const poll = setInterval(refresh, 3000); offs.push(() => clearInterval(poll));
    refresh();

    feed.replaceChildren(h('div', { class: 'bk-take' },
      h('div', { class: 'row' }, h('b', { class: 'bk-title grow' }, take.title), badge),
      h('div', { class: 'small muted' }, `Baked audio, ${fmtDur(take.duration)}. Saved as a draft in Studio.`),
      h('div', { class: 'row rd-row' }, playBtn, time, h('div', { class: 'grow' }, seek)),
      h('div', { class: 'row' }, pubBtn), note));
  }

  /* ----- recording: the soundcard's mixed sound, as it comes in ----- */
  const begin = async () => {
    if (!source.poemId) { toast('Choose a poem first.'); return false; }
    if (!navigator.mediaDevices?.getUserMedia) { toast('Recording is not available in this browser.'); return false; }
    if (!armed && !(await arm(inSel.value))) { toast(soundMsg.textContent || 'The sound card could not be opened.'); return false; }
    try { session = await startCapture({ poemId: source.poemId, stream: audioIn.stream, raw: true }); }
    catch (e) { toast('Could not start recording: ' + (e.message || e)); return false; }
    recPoemId = source.poemId;
    recording = true; t0 = Date.now();
    paint();
    return true;
  };
  const ensureRecording = () => {
    if (recording) return Promise.resolve(true);
    if (!starting) starting = begin().finally(() => { starting = null; });
    return starting;
  };
  // Starting the poem's tune also starts the recording (as the baking page always did).
  offs.push(deck.onStart((d) => { if (d.source === 'poem' && d.fresh && !recording && !saving && !take) ensureRecording().then((ok) => { if (!ok) deck.pause(); }); }));

  const stopAndSave = async () => {
    if (saving) return;
    saving = true; paint();
    deck.pause();
    let capId = null;
    try { capId = await session.stop(); } catch (e) { toast('Saving failed: ' + (e.message || e)); }
    recording = false; session = null;
    const cap = capId ? await db.captures.get(capId) : null;
    if (!cap || !cap.blob || !cap.blob.size) { toast('Nothing was recorded.'); saving = false; paint(); return; }
    const poem = await db.poems.get(recPoemId);
    const bid = uid(); const t = now();
    const bake = {
      id: bid, poemId: recPoemId, captureId: null, tuneId: null, tuneVolume: null, tuneOffset: null,
      mime: cap.mime, duration: cap.duration, blob: cap.blob, r2Key: `bakes/${bid}.${extFor(cap.mime)}`,
      createdAt: t, updatedAt: t, dirty: 1, blobPending: 1,
    };
    await db.bakes.put(bake);
    // the same sound is now the baked file, so the separate recording is removed instead of being uploaded twice
    await db.captures.where('id').equals(capId).modify((c) => { c.deletedAt = now(); c.updatedAt = now(); c.dirty = 1; c.blobPending = 0; delete c.blob; });
    let itemId = null;
    try { itemId = await createDraftFromBake(bake); } catch (e) { toast('Baked, but the Studio draft could not be made: ' + (e.message || e)); }
    syncSoon();
    saving = false;
    if (!itemId) { toast('Saved. Find it in Studio.'); return leave(); }
    take = { bakeId: bid, itemId, title: poem && !poem.deletedAt ? poemName(poem) : 'Baked poem', duration: cap.duration, blob: cap.blob };
    showTake();
    paint();
  };

  rec.onclick = async () => {
    if (saving || starting || take) return;
    if (!recording) { await ensureRecording(); return; }
    if (Date.now() - t0 < 800) return;   // ignore an accidental double tap
    stopAndSave();
  };

  function leave() {
    if (recording || saving) return;
    nav.back();
  }
  done.onclick = () => leave();

  /* ----- painting ----- */
  const paint = () => {
    status.textContent = recording ? '● REC' : saving ? 'Saving…' : take ? 'Saved' : 'Ready';
    status.className = 'badge' + (recording ? ' onair' : '');
    timer.textContent = recording ? clock((Date.now() - t0) / 1000) : '';
    rec.hidden = !!take; done.hidden = !take;
    rec.className = 'btn small' + (recording ? ' danger' : '');
    rec.textContent = recording ? '■ Stop' : '● Record';
    rec.disabled = saving;
    back.disabled = saving;
    const locked = recording || saving || !!take;   // the poem cannot change while recording or after the take
    src.el.querySelectorAll('select, .src-name').forEach((e) => { e.disabled = locked; });
    volText.textContent = `${Math.round(deck.s.volume * 100)}%`;
    if (document.activeElement !== vol) vol.value = deck.s.volume;
    reading.paint();
  };
  const paintTitle = async () => {
    const p = source.poemId ? await db.poems.get(source.poemId) : null;
    barTitle.textContent = p && !p.deletedAt ? poemName(p) : '';
  };
  offs.push(source.on(paintTitle), deck.on(paint));
  const tick = setInterval(paint, 500);

  root.append(head, sound, h('div', { class: 'c-split' }, reading.el, chat));
  root._dispose = () => {
    clearInterval(tick); clearInterval(meterTimer);
    for (const off of offs) { try { off(); } catch { /* ignore */ } }
    try { deck.pause(); } catch { /* ignore */ }
    try { takeAudio?.pause(); URL.revokeObjectURL(takeUrl); } catch { /* ignore */ }
    reading.dispose(); src.dispose(); barTitle.remove();
    if (!recording) audioIn.stop();
  };

  fillDevices().then(() => arm(inSel.value));   // opens the sound card so the level shows before you record
  await paintTitle();
  paint();
  // The poem name sits in the app's top bar, between the name and the Synced pill, like the live title.
  const topBar = document.querySelector('.bar');
  if (topBar) topBar.insertBefore(barTitle, topBar.querySelector('.pill'));
  return root;
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
    m.box.dataset.locked = 'Saving. Keep this open.'; // the phone's back button must not close the window now
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
      delete m.box.dataset.locked;
      saveBtn.disabled = false;
      progress.hidden = true;
      showVol();
    }
  };
}