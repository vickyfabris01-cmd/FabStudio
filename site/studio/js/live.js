// The Live tab: your sessions, scheduling, the on-air console, and publishing the replay afterwards.
import { sb } from '../../shared/supabase.js';
import { DEFAULT_SETTINGS, cleanSettings } from '../../shared/live-settings.js';
import { db, uid, now } from './db.js';
import { h, fmtDur, fmtAgo, toast, openModal, popMenu, dotsIcon, gearIcon, eyeIcon, loveIcon, commentIcon } from './ui.js';
import { deleteItemFiles } from './api.js';
import { createSelection, selectBar, tickBox } from './select.js';
import { engine } from './live-engine.js';
import { listInputs } from './live-audio.js';
import { deck, listOutputs, canChooseOutput } from './console/deck.js';
import { consoleHeader, copyLink, viewerLink } from './console/header.js';
import { statCards } from './console/stats.js';
import { readingPane } from './console/reading.js';
import { chatPane } from './console/chatfeed.js';
import { sourceControl } from './console/source.js';
import { settingsList, openSettingsModal } from './console/settings-modal.js';
import { recapPane } from './console/recap.js';
import { liveCheckRow } from './youtube.js';
import { syncAndWait, syncSoon } from './sync.js';

const needNet = () => { if (!navigator.onLine) throw new Error('This needs internet.'); };
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/* ---------- create / schedule ---------- */
async function createSession({ title, description, startsAt, settings }) {
  needNet();
  const id = uid();
  const t = now();
  const { error: e1 } = await sb.from('published_items').insert({
    id, kind: 'live', title, description, status: 'published', published_at: t, mime: null,
    comments_enabled: true, reactions_enabled: true, created_at: t, updated_at: t,
  });
  if (e1) throw e1;
  const { error: e2 } = await sb.from('live_sessions').insert({ item_id: id, state: 'scheduled', starts_at: startsAt || null, settings: cleanSettings(settings, DEFAULT_SETTINGS) });
  if (e2) { await sb.from('published_items').delete().eq('id', id); throw e2; }
  return id;
}

// "Now" opens the console straight away (you still press Go live there). "Schedule" saves the live with a planned
// start and stays on the list; the card can be opened any time before then. The settings sit behind the gear and
// are only opened when something needs to change.
function newLiveModal(nav) {
  const chosen = { ...DEFAULT_SETTINGS };
  let mode = 'now';
  const title = h('input', { placeholder: 'Title viewers will see', maxlength: 120 });
  const desc = h('input', { placeholder: 'A line about it (optional)', maxlength: 200 });
  const when = h('input', { type: 'datetime-local', 'aria-label': 'Planned start' });
  const whenBox = h('div', { hidden: true }, when);
  const startHint = h('p', { class: 'small muted', style: 'margin:0' });
  const nowBtn = h('button', { class: 'btn primary', type: 'button' }, 'Now');
  const laterBtn = h('button', { class: 'btn', type: 'button' }, 'Schedule');
  const err = h('p', { class: 'error' });
  const go = h('button', { class: 'btn primary', type: 'button' });
  const gear = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Live settings', 'aria-expanded': 'false', title: 'Live settings' }, gearIcon());
  const panel = h('div', { hidden: true }, settingsList(chosen, (patch) => Object.assign(chosen, patch), { skip: ['Reactions', 'Host', 'YouTube video'] }));
  gear.onclick = () => { panel.hidden = !panel.hidden; gear.setAttribute('aria-expanded', String(!panel.hidden)); };
  const setMode = (m) => {
    mode = m;
    nowBtn.className = 'btn' + (m === 'now' ? ' primary' : '');
    laterBtn.className = 'btn' + (m === 'later' ? ' primary' : '');
    whenBox.hidden = m !== 'later';
    startHint.textContent = m === 'now' ? 'Opens the console. You press Go live when you are ready.' : 'Saved as scheduled. Viewers see a countdown. You still press Go live.';
    go.textContent = m === 'now' ? 'Open console' : 'Schedule live';
    if (m === 'later') when.focus();
  };
  nowBtn.onclick = () => setMode('now');
  laterBtn.onclick = () => setMode('later');
  setMode('now');
  const { close, box } = openModal(
    h('div', { class: 'row' }, h('h3', { class: 'grow', style: 'margin:0' }, 'New live'), gear),
    title, desc,
    h('div', { class: 'row', style: 'gap:.5rem' }, h('span', { class: 'small muted' }, 'Start'), nowBtn, laterBtn),
    whenBox, startHint, panel, err,
    h('div', { class: 'row', style: 'margin-top:.4rem' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'), h('span', { class: 'grow' }), go));
  box.classList.add('wide');
  go.onclick = async () => {
    err.textContent = '';
    if (!title.value.trim()) { err.textContent = 'Give it a title.'; return; }
    let startsAt = null;
    if (mode === 'later') {
      if (!when.value) { err.textContent = 'Pick the planned start, or choose Now.'; return; }
      const at = new Date(when.value);
      if (at.getTime() < Date.now() - 60000) { err.textContent = 'That time has passed. Pick a time ahead, or choose Now.'; return; }
      startsAt = at.toISOString();
    }
    go.disabled = true;
    try {
      const id = await createSession({ title: title.value.trim(), description: desc.value.trim(), startsAt, settings: chosen });
      close();
      if (mode === 'now') nav.openLive(id);
      else { toast('Live scheduled. Open its card any time to get to the console.'); nav.refresh(); }
    } catch (e) { err.textContent = e.message || String(e); go.disabled = false; }
  };
  title.focus();
}

/* ---------- list ---------- */
// Views, peak watching, Love and chat count of one live. A number that is not saved is simply left out.
export function liveStats({ views, peak, love, chats }) {
  const bits = [];
  if (views != null) bits.push(h('span', { title: 'Views' }, eyeIcon(14), h('b', {}, String(views))));
  if (peak != null) bits.push(h('span', { title: 'Peak watching' }, h('span', { class: 'stat-live', 'aria-hidden': 'true' }), h('b', {}, String(peak)), ' peak'));
  if (love != null) bits.push(h('span', { title: 'Love', class: 'is-love' }, loveIcon(14), h('b', {}, String(love))));
  if (chats != null) bits.push(h('span', { title: 'Chat messages' }, commentIcon(14), h('b', {}, String(chats))));
  return bits.length ? h('div', { class: 'stats live-stats' }, bits) : null;
}
const pickedLives = createSelection();   // Select mode of the Live list

// Deletes lives for good: the public page, the chat, Love and viewer log (they go with the item), the files, and the
// recording. Posts that were made from a recap are separate posts and stay.
async function deleteLivesFlow(rows) {
  const todo = rows.filter((r) => r.state !== 'live');
  if (!todo.length) { toast('A live that is on air cannot be deleted. End it first.'); return false; }
  if (!navigator.onLine) throw new Error('This needs internet.');
  const n = todo.length;
  if (!confirm(`Delete ${n === 1 ? 'this live' : `${n} lives`} completely?\nThe chat, viewer list, public page and the recording are removed for good. Posts you made from a recap stay.`)) return false;
  let done = 0;
  for (const r of todo) {
    try {
      await deleteItemFiles(r.item_id);
      const { error } = await sb.from('published_items').delete().eq('id', r.item_id);   // takes the live, its chat, Love and viewer log with it
      if (error) throw error;
      if (r.capture_id) {
        // the recording is removed from online storage by the next sync, like any deleted recording
        await db.captures.where('id').equals(r.capture_id).modify((c) => { c.deletedAt = now(); c.updatedAt = now(); c.dirty = 1; c.blobPending = 0; delete c.blob; });
        await db.meta.delete(`peaks:${r.capture_id}`);
      }
      await db.items.delete(r.item_id);
      if (engine.s.itemId === r.item_id && !engine.active) await engine.close();
      done++;
    } catch (e) { toast(`Could not delete a live: ${e.message || e}`); }
  }
  if (done) syncSoon(500);
  toast(`${done} live${done === 1 ? '' : 's'} deleted.`);
  return done > 0;
}

export async function liveListView(nav) {
  const wrap = h('div', { class: 'live-list' });
  wrap.append(h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Live'), h('button', { class: 'btn primary', type: 'button', onclick: () => newLiveModal(nav) }, 'New live')));
  if (engine.active) wrap.append(h('button', { class: 'btn rec live', type: 'button', style: 'width:100%;margin:.8rem 0', onclick: () => nav.openLive(engine.s.itemId) }, '● On air: open the console'));
  const body = h('div', { class: 'live-grid' }, h('p', { class: 'muted' }, navigator.onLine ? 'Loading…' : 'Live sessions need internet.'));
  wrap.append(body);
  if (navigator.onLine) {
    try {
      const { data: rows, error } = await sb.from('live_sessions').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const { data: items } = await sb.from('published_items').select('id,title,public_media_key').in('id', (rows || []).map((r) => r.item_id));
      const by = new Map((items || []).map((i) => [i.id, i]));
      // The numbers on each card come from saved data: views (counters), Love and chats (live_totals, migration 007), peak (live_sessions).
      const ids = (rows || []).map((r) => r.item_id);
      const [cnt, tot] = await Promise.all([
        ids.length ? sb.from('counters').select('item_id,n_views').in('item_id', ids).then((r) => r.data || [], () => []) : [],
        sb.rpc('live_totals').then((r) => (r.error ? [] : r.data || []), () => []),
      ]);
      const views = new Map(cnt.map((c) => [c.item_id, c.n_views || 0]));
      const totals = new Map(tot.map((t) => [t.item_id, t]));
      body.replaceChildren();
      if (!rows?.length) body.append(h('p', { class: 'muted' }, 'No lives yet. Create one, then open it on your laptop to go live.'));
      const selBar = selectBar(pickedLives, {
        onMode: () => nav.refresh(),
        onDelete: async () => {
          const chosen = (rows || []).filter((r) => pickedLives.ids.has(r.item_id));
          try { if (await deleteLivesFlow(chosen)) { pickedLives.on = false; pickedLives.ids.clear(); nav.refresh(); } } catch (e) { toast(e.message || String(e)); }
        },
      });
      if (rows?.length) wrap.insertBefore(selBar.el, body);
      for (const r of rows || []) {
        const it = by.get(r.item_id) || {};
        const label = r.state === 'live' ? 'On air' : r.state === 'ended' ? (it.public_media_key ? 'Replay published' : 'Ended') : r.starts_at ? `Planned ${new Date(r.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not started';
        const onAir = r.state === 'live';
        const box = pickedLives.on && !onAir ? tickBox(pickedLives.ids.has(r.item_id)) : null;
        const card = h('div', { class: 'live-card' + (pickedLives.on && pickedLives.ids.has(r.item_id) ? ' picked' : '') });
        const main = h('button', { class: 'live-row', type: 'button', onclick: () => {
          if (!pickedLives.on) return nav.openLive(r.item_id);
          if (onAir) return toast('A live on air cannot be deleted.');
          if (pickedLives.ids.has(r.item_id)) pickedLives.ids.delete(r.item_id); else pickedLives.ids.add(r.item_id);
          box.checked = pickedLives.ids.has(r.item_id); card.classList.toggle('picked', box.checked); selBar.paint();
        } },
          box,
          h('div', { class: 'grow' }, h('b', {}, it.title || 'Untitled'), h('div', { class: 'small muted' }, label + (r.state === 'ended' && r.started_at ? ` · ${new Date(r.started_at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}` : '')),
            r.state !== 'live' && r.state !== 'ended' ? null : liveStats({ views: views.get(r.item_id), peak: r.peak_viewers, love: totals.get(r.item_id)?.love, chats: totals.get(r.item_id)?.chats })),
          h('span', { class: 'badge', 'data-status': onAir ? 'published' : '' }, r.state));
        card.append(main);
        if (!pickedLives.on && !onAir) {
          const dots = h('button', { class: 'iconbtn live-dots', type: 'button', 'aria-label': 'More', onclick: (e) => {
            e.stopPropagation();
            popMenu(dots, [
              { label: 'Open', onclick: () => nav.openLive(r.item_id) },
              { label: 'Delete', danger: true, onclick: async () => { try { if (await deleteLivesFlow([r])) nav.refresh(); } catch (err) { toast(err.message || String(err)); } } },
            ]);
          } }, dotsIcon(20));
          card.append(h('div', { class: 'menuwrap live-menu' }, dots));
        }
        body.append(card);
      }
    } catch (e) { body.replaceChildren(h('p', { class: 'error' }, 'Could not load: ' + (e.message || e) + '. Did you run migrations 005_live.sql and 006_live_part1.sql?')); }
  }
  return wrap;
}

/* ---------- console ---------- */
// Keeps what viewers see in step with the Deck: what is playing, and a marker in the recording when something starts.
let deckLinked = false;
function linkDeck() {
  if (deckLinked) return;
  deckLinked = true;
  deck.onStart((d) => {
    engine.setShow({ playing: d.name });
    if (d.fresh) engine.addMarker({ label: d.name, kind: d.source === 'poem' ? 'poem' : 'dead moment' });
  });
  deck.onStop(() => engine.setShow({ playing: '' }));
}

export async function liveConsoleView(itemId, nav) {
  const root = h('div', { class: 'console' });
  try { await engine.open(itemId); }
  catch (e) { root.append(h('p', { class: 'error' }, e.message || String(e)), h('button', { class: 'btn', onclick: () => nav.liveList() }, 'Back')); return root; }
  linkDeck();
  engine.sendPoems();

  const s = () => engine.s;
  const src = sourceControl();   // Poem | Music, and the name area, in the header
  const header = consoleHeader({ engine, nav, itemId, openSettings: () => openSettingsModal(), slot: src.el });
  const stats = statCards(engine);
  const reading = await readingPane();
  const chat = chatPane(engine, stats.el);   // the counts live in the chat header

  /* ----- scheduled card: shown until the live is on air ----- */
  const when = h('div', { class: 'muted' });
  const linkIn = h('input', { readonly: true, value: viewerLink(itemId), 'aria-label': 'Viewer link' });
  const go = h('button', { class: 'btn primary big', type: 'button' }, 'Go live');
  go.onclick = async () => {
    go.disabled = true;
    try { await engine.goLive(); } catch (e) { toast(e.message || 'Could not go live'); }
    go.disabled = false;
  };
  // Going live needs a laptop (sound card, recording). A phone can schedule a live and share its link, but not start it.
  const laptop = window.matchMedia('(min-width: 900px)').matches;
  const sched = h('section', { class: 'card c-sched' },
    h('div', { class: 'c-sched-t' }, h('b', {}, laptop ? 'Ready when you are' : 'Scheduled'), when, h('div', { class: 'small muted' }, laptop ? 'Goes straight on air. It never starts by itself.' : 'Go live from a laptop. Share the link below so people know where to join.')),
    h('div', { class: 'row c-sched-l' }, h('div', { class: 'grow' }, linkIn), h('button', { class: 'btn small', type: 'button', onclick: () => copyLink(itemId) }, 'Copy')),
    laptop ? go : null);

  /* ----- YouTube video: the Check YouTube live button, on the ready card (before the live is on air) ----- */
  const yt = liveCheckRow({ settings: () => engine.s.row.settings, save: (patch) => engine.saveSettings(patch) });
  const ytCard = h('section', { class: 'card c-yt' }, yt.el);

  /* ----- sound strip: level, gain, volume, input, output, show title ----- */
  const sel = h('select', { 'aria-label': 'Audio input' });
  const outSel = h('select', { 'aria-label': 'Audio output' });
  const meterFill = h('div', { class: 'meter-fill' });
  const gain = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: 1, 'aria-label': 'Input gain' });
  gain.oninput = () => engine.audio?.setGain(Number(gain.value));
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: deck.s.volume, 'aria-label': 'Volume of the poem tune and music' });
  const volText = h('span', { class: 'small muted c-voltxt' }, '100%');
  vol.oninput = () => deck.setVolume(Number(vol.value));
  const titleOn = h('input', { type: 'checkbox', checked: !!engine.s.show.title });
  titleOn.onchange = () => engine.setShow({ title: titleOn.checked });
  const audioMsg = h('p', { class: 'small error' });
  let localMsg = '';
  const test = h('button', { class: 'btn small', type: 'button' }, 'Open soundcard');
  const loadInputs = async () => {
    const inputs = await listInputs();
    sel.replaceChildren(h('option', { value: '' }, 'Default input'), ...inputs.map((i) => h('option', { value: i.id }, i.label)));
    sel.value = engine.deviceId || '';
    const outs = await listOutputs();
    outSel.replaceChildren(h('option', { value: '' }, 'Default output'), ...outs.filter((o) => o.id !== 'default').map((o) => h('option', { value: o.id }, o.label)));
    outSel.value = outs.some((o) => o.id === deck.s.outId) ? deck.s.outId : '';
  };
  sel.onchange = async () => { localMsg = ''; try { await engine.prepare(sel.value); } catch (e) { localMsg = e.message; paint(); } };
  outSel.onchange = () => deck.setOutput(outSel.value);
  outSel.disabled = !canChooseOutput();
  if (outSel.disabled) outSel.title = 'This browser cannot choose an output. Use Chrome or Edge.';
  test.onclick = async () => { localMsg = ''; try { await engine.prepare(sel.value); await loadInputs(); } catch (e) { localMsg = e.name === 'NotAllowedError' ? 'The browser blocked the microphone.' : (e.message || String(e)); paint(); } };
  const sound = h('section', { class: 'card c-sound' },
    h('div', { class: 'row c-soundrow' },
      h('span', { class: 'small muted' }, 'Level'), h('div', { class: 'meter c-meter' }, meterFill),
      h('span', { class: 'small muted' }, 'Gain'), h('div', { style: 'width:100px' }, gain),
      h('span', { class: 'small muted' }, 'Vol'), h('div', { style: 'width:100px' }, vol), volText,
      h('span', { class: 'small muted' }, 'In'), h('div', { class: 'c-sel' }, sel), test,
      h('span', { class: 'small muted' }, 'Out'), h('div', { class: 'c-sel' }, outSel),
      h('label', { class: 'row small', title: 'Viewers see the poem title while this is on' }, titleOn, h('span', {}, 'Show title'))),
    audioMsg);
  const onDevices = () => loadInputs();
  navigator.mediaDevices?.addEventListener?.('devicechange', onDevices);

  /* ----- after the session: the recap ----- */
  const afterBox = h('div', { class: 'c-after', hidden: true });
  let recap = null; let recapBusy = false;
  const paintAfter = async () => {
    afterBox.hidden = false;
    if (recap) return recap.paint();
    if (recapBusy) return;
    recapBusy = true;
    try {
      const st = s();
      const cap = st.captureId ? await db.captures.get(st.captureId) : null;
      recap = await recapPane({
        engine, itemId, cap, title: st.row.title,
        published: async () => { const { data: item } = await sb.from('published_items').select('public_media_key').eq('id', itemId).single(); return !!item?.public_media_key; },
      });
      afterBox.replaceChildren(recap.el);
      recap.paint();
    } catch (e) { afterBox.replaceChildren(h('p', { class: 'error' }, 'Could not open the recap: ' + (e.message || e))); }
    recapBusy = false;
  };

  root.append(header.el, sched, ytCard, sound, h('div', { class: 'c-split' }, reading.el, afterBox, chat.el));

  const paint = () => {
    const st = s();
    const ended = st.phase === 'ended';
    const pre = !ended && st.phase !== 'live';
    root.classList.toggle('ended', ended);   // on one screen without scrolling, except for the recap
    header.paint();
    stats.el.hidden = pre || ended;   // the recap has its own saved numbers
    stats.paint();
    sched.hidden = !pre;
    ytCard.hidden = !pre;
    if (pre) yt.paint();
    if (pre) {
      const at = st.row.starts_at;
      when.textContent = at ? `Planned start ${new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'No start time set. Press Go live whenever you are ready.';
      go.disabled = st.conn !== 'open' || st.phase === 'starting';
    }
    meterFill.style.width = `${Math.round(st.level * 100)}%`;
    meterFill.classList.toggle('hot', st.level > 0.92);
    sound.hidden = ended || !laptop;       // the sound card strip is for the laptop
    src.el.hidden = ended;
    if (document.activeElement !== vol) vol.value = deck.s.volume;
    volText.textContent = `${Math.round(deck.s.volume * 100)}%`;
    if (document.activeElement !== titleOn) titleOn.checked = !!st.show.title;
    test.hidden = !!engine.audio;
    audioMsg.textContent = localMsg || st.error;
    reading.el.hidden = ended;
    chat.el.hidden = ended;   // after the live the recap has its own read-only Chats | Viewers panel
    reading.paint();
    chat.paint();
    if (ended) paintAfter();
  };

  const off = engine.on(paint);
  const offDeck = deck.on(paint);
  const tick = setInterval(paint, 1000);
  root._dispose = () => { off(); offDeck(); clearInterval(tick); reading.dispose(); src.dispose(); header.titleEl.remove(); recap?.dispose(); navigator.mediaDevices?.removeEventListener?.('devicechange', onDevices); };
  await loadInputs();
  paint();
  // The live title is shown in the app's top bar, between the name and the Synced pill, and is editable there.
  const topBar = document.querySelector('.bar');
  header.titleEl.classList.add('bar-title');
  if (topBar) topBar.insertBefore(header.titleEl, topBar.querySelector('.pill'));
  return root;
}
