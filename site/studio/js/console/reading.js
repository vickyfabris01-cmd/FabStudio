// The reading pane: the poem text with a speed drawer for auto-scroll, and ONE play row (play, time, seek) for
// whatever the header's Poem | Music control has picked. Picking happens in the header (source.js); nothing is
// loaded until you pick it. Everything plays through the Deck (one player), so a tune and a laptop file never
// play together. Volume and "Show title" live in the sound strip.
import { db } from '../db.js';
import { getBlob } from '../sync.js';
import { h, fmtDur, toast } from '../ui.js';
import { engine } from '../live-engine.js';
import { deck } from './deck.js';
import { source, poemName } from './source.js';
import { playlist } from './playlist.js';

export async function readingPane() {
  const poems = (await db.poems.toArray()).filter((p) => !p.deletedAt);
  let poem = null; let tune = null; let tuneBlob = null;
  let scrolling = false; let pos = 0; let raf = 0; let last = 0;
  const key = () => (poem ? `poem:${poem.id}` : null);
  // What the play row controls: the poem's own tune in Poem mode, the picked file in Music mode.
  const activeKey = () => (source.mode === 'music' ? (source.music?.key || null) : key());

  /* ----- the play row ----- */
  const playBtn = h('button', { class: 'btn small rd-play', type: 'button', 'aria-label': 'Play' }, '▶');
  const tuneTime = h('span', { class: 'muted small rd-time' });
  const seek = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Position', class: 'rd-seek' });
  // Music mode only: previous, next and loop all (inside the folder of the playing track)
  const prevBtn = h('button', { class: 'btn small rd-pn', type: 'button', 'aria-label': 'Previous track', title: 'Previous track' }, '⏮');
  const nextBtn = h('button', { class: 'btn small rd-pn', type: 'button', 'aria-label': 'Next track', title: 'Next track' }, '⏭');
  const loopBtn = h('button', { class: 'btn small rd-loop', type: 'button', 'aria-label': 'Loop all in this folder', title: 'Loop all in this folder', 'aria-pressed': 'false' }, '⟳');
  prevBtn.onclick = () => playlist.step(-1);
  nextBtn.onclick = () => playlist.step(1);
  loopBtn.onclick = () => playlist.setLoop(!playlist.loop);
  const musicBtns = h('span', { class: 'rd-music', hidden: true }, prevBtn, nextBtn, loopBtn);
  const bar = h('div', { class: 'row rd-row' }, playBtn, musicBtns, tuneTime, h('div', { class: 'grow' }, seek));

  /* ----- the text ----- */
  const text = h('div', { class: 'rd-text', tabindex: 0 });
  const speed = h('input', { type: 'range', min: 1, max: 100, step: 1, value: 30, 'aria-label': 'Scroll speed', class: 'rd-speed-in', orient: 'vertical' });
  const scrollBtn = h('button', { class: 'rd-scroll', type: 'button', 'aria-label': 'Start or stop scrolling', title: 'Scroll' }, '↓');
  const drawer = h('div', { class: 'rd-speed' }, scrollBtn, speed);

  seek.oninput = () => { const k = activeKey(); if (k && deck.isLoaded(k)) deck.seek(Number(seek.value)); };
  speed.oninput = () => { drawer.classList.add('active'); clearTimeout(speed._t); speed._t = setTimeout(() => drawer.classList.remove('active'), 3000); };
  drawer.addEventListener('pointerdown', () => { drawer.classList.add('active'); clearTimeout(drawer._t); drawer._t = setTimeout(() => drawer.classList.remove('active'), 3000); });
  scrollBtn.onclick = () => setScrolling(!scrolling);
  for (const ev of ['wheel', 'touchstart', 'pointerdown']) text.addEventListener(ev, () => { pos = text.scrollTop; }, { passive: true });

  playBtn.onclick = async () => {
    if (source.mode === 'music') {
      const m = source.music;
      if (!m) return toast('Choose music first.');
      if (deck.isPlaying(m.key)) return deck.pause();
      if (deck.isLoaded(m.key)) return deck.resume();
      try { await deck.play(await m.handle.getFile(), { source: 'file', key: m.key, name: m.name }); }
      catch { toast('That file could not be opened. It may have been moved.'); }
      return;
    }
    if (!poem) return toast('Choose a poem first.');
    if (deck.isPlaying(key())) return deck.pause();
    if (deck.isLoaded(key())) return deck.resume();
    if (!tune) return toast('This poem has no tune. Add one in Poems.');
    if (!tuneBlob) tuneBlob = await getBlob('tunes', tune);
    if (!tuneBlob) return toast('The tune is not on this device yet. Connect to the internet to download it.');
    await deck.play(tuneBlob, { source: 'poem', key: key(), name: tune.title || poemName(poem) });
  };

  // Shows the poem picked in the header. An empty id shows the "choose" hint and loads nothing.
  async function choose(id) {
    const picked = poems.find((p) => p.id === id) || null;
    poem = picked;
    tune = null; tuneBlob = null;
    text.replaceChildren(...(poem ? [h('div', { class: 'rd-title' }, poemName(poem)), ...(poem.stanzas || []).map((s) => h('p', { class: 'rd-stanza' }, s))] : [h('p', { class: 'muted rd-empty' }, 'Choose a poem from the bar above.')]));
    text.scrollTop = 0; pos = 0;
    if (engine.s.show.poem !== (poem?.title || '').trim()) engine.setShow({ poem: (poem?.title || '').trim() });
    const t = poem?.tuneId ? await db.tunes.get(poem.tuneId) : null;
    if (poem !== picked) return;   // another poem was picked while this one was loading
    tune = t && !t.deletedAt ? t : null;
    if (tune) { getBlob('tunes', tune).then((b) => { if (tune && poem === picked) tuneBlob = b; }).catch(() => {}); }  // ready before the first tap
    paint();
  }

  /* ----- auto-scroll: only when the poem is taller than the pane ----- */
  const tall = () => text.scrollHeight > text.clientHeight + 4;
  function setScrolling(on) {
    scrolling = on && tall();
    scrollBtn.classList.toggle('on', scrolling);
    cancelAnimationFrame(raf);
    if (!scrolling) return;
    last = 0;
    const step = (t) => {
      if (!scrolling) return;
      if (last) pos = Math.min(text.scrollHeight - text.clientHeight, pos + ((t - last) / 1000) * Number(speed.value) * 0.6);
      last = t;
      text.scrollTop = pos;
      if (pos >= text.scrollHeight - text.clientHeight - 1) return setScrolling(false);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  // The poem's own tune starting or pausing starts or pauses the scroll.
  const offStart = deck.onStart((d) => { if (d.key === key()) setScrolling(true); });
  const offStop = deck.onStop(() => { if (scrolling) setScrolling(false); });
  // The header picked another poem (or switched between Poem and Music).
  const offPlaylist = playlist.on(() => paint());
  const offSource = source.on(() => { if (source.poemId !== (poem?.id || '')) choose(source.poemId); else paint(); });

  const el = h('section', { class: 'card c-read' }, bar, h('div', { class: 'rd-text-wrap' }, text, drawer));

  function paint() {
    const d = deck.s;
    const k = activeKey();
    const mine = !!k && d.key === k;
    playBtn.textContent = mine && d.playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', mine && d.playing ? 'Pause' : 'Play');
    const idle = source.mode === 'poem' && tune?.duration ? `0:00 / ${fmtDur(tune.duration)}` : '0:00';
    tuneTime.textContent = d.error || (mine ? `${fmtDur(d.time)} / ${fmtDur(d.duration)}` : idle);
    tuneTime.classList.toggle('error', !!d.error);
    musicBtns.hidden = source.mode !== 'music';
    const hasList = !!playlist.ctx;
    prevBtn.disabled = nextBtn.disabled = !hasList;
    loopBtn.classList.toggle('on', playlist.loop);
    loopBtn.setAttribute('aria-pressed', String(playlist.loop));
    seek.max = mine ? (d.duration || 1) : 1;
    if (document.activeElement !== seek) seek.value = mine ? d.time : 0;
    drawer.hidden = !tall();
  }

  await choose(source.poemId);   // empty on a fresh start: nothing is loaded until you pick it
  return { el, paint, dispose() { cancelAnimationFrame(raf); scrolling = false; offStart(); offStop(); offSource(); offPlaylist(); } };
}
