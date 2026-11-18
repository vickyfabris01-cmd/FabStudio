// The reading pane: tabs Poem | My audio. The Poem tab has the poem picker, the play row for that poem's own
// tune, the volume with the "show title" switch, and the poem text with a speed drawer for auto-scroll.
// Everything plays through the Deck (one player), so a tune and a laptop file never play together.
import { db } from '../db.js';
import { getBlob } from '../sync.js';
import { h, fmtDur, toast } from '../ui.js';
import { engine } from '../live-engine.js';
import { deck } from './deck.js';
import { myAudioPane } from './myaudio.js';

const LAST_POEM = 'fabstudio.live.poem';
const poemName = (p) => (p.title || '').trim() || (p.stanzas?.[0] || '').split('\n')[0] || 'Untitled';

export async function readingPane() {
  const poems = (await db.poems.toArray()).filter((p) => !p.deletedAt).sort((a, b) => poemName(a).localeCompare(poemName(b)));
  let poem = null; let tune = null; let tuneBlob = null;
  let scrolling = false; let pos = 0; let raf = 0; let last = 0;
  const key = () => (poem ? `poem:${poem.id}` : null);

  /* ----- tabs ----- */
  const tabPoem = h('button', { class: 'tab on', type: 'button' }, 'Poem');
  const tabAudio = h('button', { class: 'tab', type: 'button' }, 'My audio');
  const audioPane = myAudioPane();
  const poemTab = h('div', { class: 'rd-poem' });
  const audioTab = h('div', { class: 'rd-audio', hidden: true }, audioPane.el);
  const show = (which) => {
    tabPoem.classList.toggle('on', which === 'poem'); tabAudio.classList.toggle('on', which === 'audio');
    poemTab.hidden = which !== 'poem'; audioTab.hidden = which !== 'audio';
  };
  tabPoem.onclick = () => show('poem'); tabAudio.onclick = () => show('audio');

  /* ----- poem tab ----- */
  const pick = h('select', { 'aria-label': 'Poem', class: 'rd-pick' }, h('option', { value: '' }, poems.length ? 'Choose a poem…' : 'No poems yet'),
    poems.map((p) => h('option', { value: p.id }, poemName(p))));
  const playBtn = h('button', { class: 'btn small rd-play', type: 'button', 'aria-label': 'Play' }, '▶');
  const tuneName = h('span', { class: 'grow rd-tune' });
  const tuneTime = h('span', { class: 'muted small' });
  const seek = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Position', class: 'rd-seek' });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: deck.s.volume, 'aria-label': 'Volume' });
  const volText = h('span', { class: 'small muted rd-vol' }, '100%');
  const titleOn = h('input', { type: 'checkbox', checked: !!engine.s.show.title });
  const text = h('div', { class: 'rd-text', tabindex: 0 });
  const speed = h('input', { type: 'range', min: 1, max: 100, step: 1, value: 30, 'aria-label': 'Scroll speed', class: 'rd-speed-in', orient: 'vertical' });
  const scrollBtn = h('button', { class: 'rd-scroll', type: 'button', 'aria-label': 'Start or stop scrolling', title: 'Scroll' }, '↓');
  const drawer = h('div', { class: 'rd-speed' }, scrollBtn, speed);

  titleOn.onchange = () => engine.setShow({ title: titleOn.checked });
  vol.oninput = () => deck.setVolume(Number(vol.value));
  seek.oninput = () => { if (deck.isLoaded(key())) deck.seek(Number(seek.value)); };
  speed.oninput = () => { drawer.classList.add('active'); clearTimeout(speed._t); speed._t = setTimeout(() => drawer.classList.remove('active'), 3000); };
  drawer.addEventListener('pointerdown', () => { drawer.classList.add('active'); clearTimeout(drawer._t); drawer._t = setTimeout(() => drawer.classList.remove('active'), 3000); });
  scrollBtn.onclick = () => setScrolling(!scrolling);
  for (const ev of ['wheel', 'touchstart', 'pointerdown']) text.addEventListener(ev, () => { pos = text.scrollTop; }, { passive: true });

  playBtn.onclick = async () => {
    if (!poem) return toast('Choose a poem first.');
    if (deck.isPlaying(key())) return deck.pause();
    if (deck.isLoaded(key())) return deck.resume();
    if (!tune) return toast('This poem has no tune. Add one in Poems.');
    if (!tuneBlob) tuneBlob = await getBlob('tunes', tune);
    if (!tuneBlob) return toast('The tune is not on this device yet. Connect to the internet to download it.');
    await deck.play(tuneBlob, { source: 'poem', key: key(), name: tune.title || poemName(poem) });
  };

  async function choose(id) {
    poem = poems.find((p) => p.id === id) || null;
    tune = poem?.tuneId ? await db.tunes.get(poem.tuneId) : null;
    if (tune?.deletedAt) tune = null;
    tuneBlob = null;
    localStorage.setItem(LAST_POEM, id || '');
    pick.value = poem?.id || '';
    tuneName.textContent = poem ? (tune ? (tune.title || 'Tune') : 'No tune for this poem') : '';
    text.replaceChildren(...(poem ? [h('div', { class: 'rd-title' }, poemName(poem)), ...(poem.stanzas || []).map((s) => h('p', { class: 'rd-stanza' }, s))] : [h('p', { class: 'muted' }, 'Choose a poem to read from.')]));
    text.scrollTop = 0; pos = 0;
    if (engine.s.show.poem !== (poem?.title || '').trim()) engine.setShow({ poem: (poem?.title || '').trim() });
    if (tune) { getBlob('tunes', tune).then((b) => { if (tune && poem?.id === id) tuneBlob = b; }).catch(() => {}); }  // ready before the first tap
    paint();
  }
  pick.onchange = () => choose(pick.value);

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

  poemTab.append(pick,
    h('div', { class: 'row rd-row' }, playBtn, tuneName, tuneTime),
    seek,
    h('div', { class: 'row rd-row' }, h('span', { class: 'small muted' }, 'Volume'), h('div', { style: 'width:140px' }, vol), volText, h('span', { class: 'grow' }),
      h('label', { class: 'row small' }, titleOn, h('span', {}, 'Show title'))),
    h('div', { class: 'rd-text-wrap' }, text, drawer));

  const el = h('section', { class: 'card c-read' }, h('div', { class: 'row rd-tabs' }, tabPoem, tabAudio), poemTab, audioTab);

  function paint() {
    audioPane.paint();
    const d = deck.s;
    const mine = key() && d.key === key();
    playBtn.textContent = mine && d.playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', mine && d.playing ? 'Pause' : 'Play');
    tuneTime.textContent = mine ? `${fmtDur(d.time)} / ${fmtDur(d.duration)}` : (tune?.duration ? `0:00 / ${fmtDur(tune.duration)}` : '');
    seek.max = mine ? (d.duration || 1) : 1;
    if (document.activeElement !== seek) seek.value = mine ? d.time : 0;
    if (document.activeElement !== vol) vol.value = d.volume;
    volText.textContent = `${Math.round(d.volume * 100)}%`;
    if (document.activeElement !== titleOn) titleOn.checked = !!engine.s.show.title;
    drawer.hidden = !tall();
    if (d.error) tuneName.textContent = d.error;
  }

  const last0 = localStorage.getItem(LAST_POEM);
  await choose(poems.some((p) => p.id === last0) ? last0 : '');
  return { el, paint, dispose() { cancelAnimationFrame(raf); scrolling = false; offStart(); offStop(); audioPane.dispose(); } };
}
