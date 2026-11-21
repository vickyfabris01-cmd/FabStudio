// Baking: read a poem while the microphone and the poem's background tune are recorded together,
// then preview the result and, if needed, change the tune volume.
import { db, uid, now } from './db.js';
import { getBlob, syncSoon } from './sync.js';
import { startCapture } from './recorder.js';
import { LiveMix, BAKE_TUNE_VOLUME, loadRemix, Remix, rebake } from './mixer.js';
import { createDraftFromBake, syncDraftFromBake } from './publish.js';
import { h, fmtDur, fmtDate, extFor, toast, openModal, micIcon, stopIcon } from './ui.js';
import { LiveAudio, listInputs } from './live-audio.js';
import { listOutputs } from './console/deck.js';

// Baking is done on a laptop (a screen at least 900px wide), where the sound card gives a proper mix. A phone can
// still publish, edit and delete everything that was baked.
const isLaptop = () => window.matchMedia('(min-width: 900px)').matches;
function laptopOnlyView(nav) {
  return h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, h('button', { class: 'btn small', type: 'button', onclick: () => nav.back() }, '← Studio')),
    h('h2', {}, 'Bake on a laptop'),
    h('p', { class: 'muted' }, 'Baking mixes your voice with the poem’s tune, and needs a laptop with a proper sound card for a good result. Open the Studio on your laptop to bake. Baked audio already made shows up here, and you can publish, edit or delete it from your phone.'));
}
const bakePrefs = () => { try { return JSON.parse(localStorage.getItem('fabstudio.bake') || '{}'); } catch { return {}; } };
const saveBakePrefs = (p) => { try { localStorage.setItem('fabstudio.bake', JSON.stringify({ ...bakePrefs(), ...p })); } catch { /* ignore */ } };

const poemName = (p) => p.title || (p.stanzas?.[0] || '').split('\n')[0] || 'Untitled';

/* ---------- step 1: choose a poem ---------- */
async function pickPoemView(nav) {
  if (!isLaptop()) return laptopOnlyView(nav);
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

// Opens the microphone the phone picks by itself: an external one when it is connected, otherwise the built-in one.
// Baking always uses raw audio (no voice processing). With voice processing on, Android switches to call mode and
// plays the background tune like a call instead of through the soundcard. The tune is mixed digitally, so the
// echo cancellation is not needed (use headphones).
function openMic() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
}

/* ---------- step 2: the baking page ---------- */
export async function bakerView({ poemId, nav }) {
  if (!isLaptop()) return laptopOnlyView(nav);
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

  /* the sound strip, the same one the live console uses: input, gain, level, output */
  const audioIn = new LiveAudio();
  let armed = false;
  const inSel = h('select', { 'aria-label': 'Audio input' });
  const outSel = h('select', { 'aria-label': 'Audio output (where you hear the tune)' });
  const gain = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: String(bakePrefs().gain ?? 1), 'aria-label': 'Input gain' });
  const meterFill = h('div', { class: 'meter-fill' });
  const soundMsg = h('p', { class: 'small error' });
  gain.oninput = () => { audioIn.setGain(Number(gain.value)); saveBakePrefs({ gain: Number(gain.value) }); };
  const fillDevices = async () => {
    const ins = await listInputs();
    inSel.replaceChildren(h('option', { value: '' }, 'Default input'), ...ins.map((i) => h('option', { value: i.id }, i.label)));
    inSel.value = ins.some((i) => i.id === bakePrefs().inId) ? bakePrefs().inId : '';
    const outs = await listOutputs();
    outSel.replaceChildren(h('option', { value: '' }, 'Default output'), ...outs.filter((o) => o.id !== 'default').map((o) => h('option', { value: o.id }, o.label)));
    outSel.value = outs.some((o) => o.id === bakePrefs().outId) ? bakePrefs().outId : '';
    outSel.disabled = !mix.ctx.setSinkId;
    if (outSel.disabled) outSel.title = 'This browser cannot choose an output. Use Chrome or Edge.';
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
  outSel.onchange = async () => {
    saveBakePrefs({ outId: outSel.value });
    try { await mix.ctx.setSinkId(outSel.value); soundMsg.textContent = ''; } catch (e) { soundMsg.textContent = 'Could not use that output: ' + (e.message || e.name); }
  };
  const meterTimer = setInterval(() => { meterFill.style.width = Math.round((armed ? audioIn.level() : 0) * 100) + '%'; }, 100);
  fillDevices().then(async () => {
    if (bakePrefs().outId && mix.ctx.setSinkId) mix.ctx.setSinkId(bakePrefs().outId).catch(() => {});
    await arm(inSel.value);       // opens the sound card so the level shows before you record
  });
  const sound = h('section', { class: 'card c-sound' },
    h('div', { class: 'row c-soundrow' },
      h('span', { class: 'small muted' }, 'Level'), h('div', { class: 'meter c-meter' }, meterFill),
      h('span', { class: 'small muted' }, 'Gain'), h('div', { style: 'width:100px' }, gain),
      h('span', { class: 'small muted' }, 'In'), h('div', { class: 'c-sel' }, inSel),
      h('span', { class: 'small muted' }, 'Out'), h('div', { class: 'c-sel' }, outSel)),
    soundMsg);
  // Scroll the poem for you while you read.
  const auto = h('input', { type: 'checkbox', 'aria-label': 'Scroll the poem for me' });
  const speed = h('input', { type: 'range', min: 5, max: 120, step: 5, value: '30', 'aria-label': 'Scroll speed' });
  let scrollRaf = 0; let lastT = 0; let acc = 0;
  const scrollStep = (t) => {
    scrollRaf = 0;
    if (!auto.checked) return;
    if (lastT) { acc += (Number(speed.value) * (t - lastT)) / 1000; const whole = Math.trunc(acc); if (whole) { window.scrollBy(0, whole); acc -= whole; } }
    lastT = t;
    scrollRaf = requestAnimationFrame(scrollStep);
  };
  auto.onchange = () => { lastT = 0; if (auto.checked && !scrollRaf) scrollRaf = requestAnimationFrame(scrollStep); };
  const scrollRow = h('label', { class: 'row small' }, auto, h('span', {}, 'Scroll the poem for me'), h('div', { style: 'width:110px' }, speed));
  const cleanup = () => { clearInterval(meterTimer); cancelAnimationFrame(scrollRaf); audioIn.stop(); };

  let stream = null;
  let session = null;
  let recording = false;
  let saving = false;
  let starting = null;
  let capDelay = 0;
  let t0 = 0;
  let tick = null;
  let micShown = '';

  /* the tune, shown like a file chip on the poem page */
  const chipIc = h('span', { class: 'chip-ic', 'aria-hidden': 'true' }, '▶');
  const chipSub = h('span', { class: 'chip-s' }, 'ready');
  const chipBtn = h('button', { class: 'chip-main', type: 'button', 'aria-label': 'Start the tune' },
    chipIc, h('span', {}, tune?.title || 'Tune'), chipSub);
  const chip = h('div', { class: 'chip', style: 'min-width:0' }, chipBtn);

  /* the record button, to the right of the tune */
  const micBtn = h('button', { class: 'fab rec', type: 'button', 'aria-label': 'Start recording', style: 'position:static;box-shadow:none;flex:none' });
  const timeLabel = h('span', { class: 'fab-t' }, '0:00');

  const paint = () => {
    if (recording) {
      if (micShown !== 'live') {
        micShown = 'live';
        micBtn.classList.add('live');
        micBtn.replaceChildren(stopIcon(), timeLabel);
        micBtn.setAttribute('aria-label', 'Stop recording');
      }
      timeLabel.textContent = fmtDur((Date.now() - t0) / 1000);
    } else if (micShown !== 'idle') {
      micShown = 'idle';
      micBtn.classList.remove('live');
      micBtn.replaceChildren(micIcon());
      micBtn.setAttribute('aria-label', 'Start recording');
    }
    if (hasTune) {
      const playing = mix.tunePlaying;
      const done = !playing && mix.tuneOffset != null;
      chipIc.textContent = playing ? '♪' : done ? '✓' : '▶';
      chipSub.textContent = playing ? 'playing' : done ? 'finished' : 'ready';
    }
  };

  const begin = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { toast('Recording is not available in this browser.'); return false; }
    if (!armed && !(await arm(inSel.value))) { toast(soundMsg.textContent || 'The sound card could not be opened.'); return false; }
    stream = audioIn.stream;
    try {
      await mix.begin(stream);
      session = await startCapture({ poemId, stream, raw: true });
    } catch (e) {
      stream.getTracks().forEach((tr) => tr.stop());
      toast('Could not start recording: ' + (e.message || e));
      return false;
    }
    capDelay = mix.ctx.currentTime - mix.t0;
    recording = true;
    t0 = Date.now();
    tick = setInterval(paint, 250);
    paint();
    toast('Recording with ' + (stream.getAudioTracks()[0]?.label || 'the default microphone'));
    return true;
  };
  const ensureRecording = () => {
    if (recording) return Promise.resolve(true);
    if (!starting) starting = begin().finally(() => { starting = null; });
    return starting;
  };

  // Tap the tune: the microphone starts too (if it is not already running), then the tune plays once.
  chipBtn.onclick = async () => {
    if (!hasTune) return;
    if (mix.tunePlaying) return toast('The tune is playing.');
    if (mix.tuneOffset != null) return toast('The tune plays once for each bake.');
    if (!(await ensureRecording())) return;
    mix.startTune();
    paint();
  };
  mix.onTuneEnd = () => paint();

  const stopAndSave = async () => {
    if (saving) return;
    saving = true;
    clearInterval(tick);
    micBtn.disabled = true;
    let out = null;
    let capId = null;
    try {
      out = await mix.finish();
      capId = await session.stop();
    } catch (e) {
      toast('Saving failed: ' + (e.message || e));
    }
    cleanup();
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

  // Tap the mic: start recording. Tap again: stop and save.
  micBtn.onclick = async () => {
    if (saving || starting) return;
    if (!recording) { await ensureRecording(); return; }
    if (Date.now() - t0 < 800) return; // ignore an accidental double tap
    stopAndSave();
  };

  const back = h('button', {
    class: 'btn small', type: 'button',
    onclick: () => {
      if (recording) return toast('Stop the recording first.');
      mix.dispose();
      cleanup();
      nav.back();
    },
  }, '← Studio');

  const controls = h('div', {
    class: 'bake-controls',
    style: 'position:sticky;top:3.6rem;z-index:4;background:var(--bg);display:flex;align-items:center;gap:.7rem;padding:.6rem 0;border-bottom:1px solid var(--line)',
  }, hasTune ? chip : null, micBtn);

  paint();
  const el = h('section', { class: 'view' },
    h('div', { class: 'toolbar' }, back, h('span', { class: 'status' }, 'Baking')),
    h('h2', {}, poemName(poem)),
    controls,
    sound, scrollRow,
    h('p', { class: 'muted small', style: 'margin:.5rem 0 0' }, hasTune
      ? 'Tap the tune to start it and the microphone together, or tap the red mic first and start the tune later. Use headphones.'
      : 'No background tune for this poem. Tap the red mic to record.'),
    h('div', { class: 'bake-text' }, (poem.stanzas || []).join('\n\n') || 'This poem has no text yet.'),
    h('div', { class: 'spacer' }));

  // Keep the controls just under the app header while the poem scrolls.
  setTimeout(() => {
    const bar = document.querySelector('.bar');
    if (bar) controls.style.top = `calc(${bar.offsetHeight}px + env(safe-area-inset-top))`;
  }, 0);

  el._dispose = () => { if (!recording) { mix.dispose(); cleanup(); } };
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