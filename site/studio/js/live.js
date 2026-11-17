// The Live tab: your sessions, scheduling, the on-air console, and publishing the replay afterwards.
import { sb } from '../../shared/supabase.js';
import { DEFAULT_SETTINGS, cleanSettings } from '../../shared/live-settings.js';
import { db, uid, now } from './db.js';
import { h, fmtDur, fmtAgo, toast, openModal } from './ui.js';
import { engine } from './live-engine.js';
import { listInputs } from './live-audio.js';
import { deck, listOutputs, canChooseOutput } from './console/deck.js';
import { consoleHeader, copyLink, viewerLink } from './console/header.js';
import { statCards } from './console/stats.js';
import { readingPane } from './console/reading.js';
import { chatPane } from './console/chatfeed.js';
import { settingsList, openSettingsModal } from './console/settings-modal.js';
import { uploadBlob, liveAssets } from './api.js';
import { thumbFromTitle } from './thumbs.js';
import { syncAndWait } from './sync.js';

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

function newLiveModal(nav) {
  const chosen = { ...DEFAULT_SETTINGS };
  const title = h('input', { placeholder: 'Title viewers will see', maxlength: 120 });
  const desc = h('input', { placeholder: 'A line about it (optional)', maxlength: 200 });
  const when = h('input', { type: 'datetime-local' });
  const err = h('p', { class: 'error' });
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Schedule live');
  const { close, box } = openModal(h('h3', {}, 'New live'), title, desc,
    h('label', { class: 'small muted' }, 'Planned start (optional). It only shows a countdown. You still press Go live.'), when,
    settingsList(chosen, (patch) => Object.assign(chosen, patch), { skip: ['Reactions', 'Host'] }), err,
    h('div', { class: 'row', style: 'margin-top:.4rem' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'), h('span', { class: 'grow' }), go));
  box.classList.add('wide');
  go.onclick = async () => {
    err.textContent = '';
    if (!title.value.trim()) { err.textContent = 'Give it a title.'; return; }
    go.disabled = true;
    try {
      const id = await createSession({ title: title.value.trim(), description: desc.value.trim(), startsAt: when.value ? new Date(when.value).toISOString() : null, settings: chosen });
      close(); nav.openLive(id);
    } catch (e) { err.textContent = e.message || String(e); go.disabled = false; }
  };
  box.querySelector('input').focus();
}

/* ---------- list ---------- */
export async function liveListView(nav) {
  const wrap = h('div', { class: 'live-list' });
  wrap.append(h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Live'), h('button', { class: 'btn primary', type: 'button', onclick: () => newLiveModal(nav) }, 'New live')));
  if (engine.active) wrap.append(h('button', { class: 'btn rec live', type: 'button', style: 'width:100%;margin:.8rem 0', onclick: () => nav.openLive(engine.s.itemId) }, '● On air: open the console'));
  const body = h('div', {}, h('p', { class: 'muted' }, navigator.onLine ? 'Loading…' : 'Live sessions need internet.'));
  wrap.append(body);
  if (navigator.onLine) {
    try {
      const { data: rows, error } = await sb.from('live_sessions').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const { data: items } = await sb.from('published_items').select('id,title,public_media_key').in('id', (rows || []).map((r) => r.item_id));
      const by = new Map((items || []).map((i) => [i.id, i]));
      body.replaceChildren();
      if (!rows?.length) body.append(h('p', { class: 'muted' }, 'No lives yet. Create one, then open it on your laptop to go live.'));
      for (const r of rows || []) {
        const it = by.get(r.item_id) || {};
        const label = r.state === 'live' ? 'On air' : r.state === 'ended' ? (it.public_media_key ? 'Replay published' : 'Ended') : r.starts_at ? `Planned ${new Date(r.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not started';
        body.append(h('button', { class: 'live-row', type: 'button', onclick: () => nav.openLive(r.item_id) },
          h('div', { class: 'grow' }, h('b', {}, it.title || 'Untitled'), h('div', { class: 'small muted' }, label + (r.peak_viewers ? ` · peak ${r.peak_viewers}` : ''))),
          h('span', { class: 'badge', 'data-status': r.state === 'live' ? 'published' : '' }, r.state)));
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
  const header = consoleHeader({ engine, nav, itemId, openSettings: () => openSettingsModal() });
  const stats = statCards(engine);
  const reading = await readingPane();
  const chat = chatPane(engine);

  /* ----- scheduled card: shown until the live is on air ----- */
  const when = h('div', { class: 'muted' });
  const linkIn = h('input', { readonly: true, value: viewerLink(itemId), 'aria-label': 'Viewer link' });
  const go = h('button', { class: 'btn primary big', type: 'button' }, 'Go live');
  go.onclick = async () => {
    go.disabled = true;
    try { await engine.goLive(); } catch (e) { toast(e.message || 'Could not go live'); }
    go.disabled = false;
  };
  const sched = h('section', { class: 'card c-sched' },
    h('h3', {}, 'Ready when you are'), when,
    h('div', { class: 'row', style: 'margin:.6rem 0' }, h('div', { class: 'grow' }, linkIn), h('button', { class: 'btn small', type: 'button', onclick: () => copyLink(itemId) }, 'Copy')),
    h('div', { class: 'row' }, go, h('span', { class: 'small muted' }, 'Goes straight on air. It never starts by itself.')));

  /* ----- sound strip: level, gain, input, output ----- */
  const sel = h('select', { 'aria-label': 'Audio input' });
  const outSel = h('select', { 'aria-label': 'Audio output' });
  const meterFill = h('div', { class: 'meter-fill' });
  const gain = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: 1, 'aria-label': 'Input gain' });
  gain.oninput = () => engine.audio?.setGain(Number(gain.value));
  const mon = h('input', { type: 'checkbox' });
  mon.onchange = () => engine.audio?.setMonitor(mon.checked);
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
      h('span', { class: 'small muted' }, 'In'), h('div', { class: 'c-sel' }, sel), test,
      h('span', { class: 'small muted' }, 'Out'), h('div', { class: 'c-sel' }, outSel),
      h('label', { class: 'row small', title: 'Hear what viewers hear. Use headphones, or it will echo.' }, mon, h('span', {}, 'Monitor'))),
    audioMsg);
  const onDevices = () => loadInputs();
  navigator.mediaDevices?.addEventListener?.('devicechange', onDevices);

  /* ----- after the session ----- */
  const afterBox = h('section', { class: 'card c-after', hidden: true });
  let afterKey = '';
  const paintAfter = async () => {
    const st = s();
    if (afterKey === 'busy') return;
    afterBox.hidden = false;
    const cap = st.captureId ? await db.captures.get(st.captureId) : null;
    const { data: item } = await sb.from('published_items').select('public_media_key').eq('id', itemId).single();
    const published = !!item?.public_media_key;
    const key = `${cap?.status}|${cap?.blobPending}|${cap?.dirty}|${published}`;
    if (key === afterKey) return;
    afterKey = key;
    const ready = cap && cap.status === 'done' && !cap.blobPending;
    const btn = h('button', { class: 'btn primary', type: 'button' }, published ? 'Replay is published' : 'Publish replay');
    btn.disabled = published || !ready;
    btn.onclick = async () => {
      afterKey = 'busy'; btn.disabled = true; btn.textContent = 'Publishing…';
      try { await publishReplay(itemId, cap, s().row.title); toast('Replay published.'); }
      catch (e) { toast(e.message || String(e)); }
      afterKey = ''; paintAfter();
    };
    afterBox.replaceChildren(h('h3', {}, 'After the live'),
      h('p', { class: 'small' }, `Lasted ${st.room?.startedAt && st.room?.endedAt ? fmtDur((st.room.endedAt - st.room.startedAt) / 1000) : '—'} · peak ${st.peak} watching.`),
      !cap ? h('p', { class: 'small muted' }, 'No recording was made on this device for this live.')
        : h('p', { class: 'small muted' }, ready ? 'Recording saved and uploaded to your private storage.' : cap.status !== 'done' ? 'Finishing the recording…' : 'The recording is uploading to your private storage. Keep the app open and online.'),
      h('p', { class: 'small muted' }, 'Publishing makes the recording the replay on the same page, with the same views, likes and comments. Not publishing keeps the page as "ended" with no audio.'),
      btn);
  };

  root.append(header.el, sched, stats.el, sound, h('div', { class: 'c-split' }, reading.el, afterBox, chat.el));

  const paint = () => {
    const st = s();
    const ended = st.phase === 'ended';
    const pre = !ended && st.phase !== 'live';
    header.paint();
    stats.el.hidden = pre;
    stats.paint();
    sched.hidden = !pre;
    if (pre) {
      const at = st.row.starts_at;
      when.textContent = at ? `Planned start ${new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'No start time set. Press Go live whenever you are ready.';
      go.disabled = st.conn !== 'open' || st.phase === 'starting';
    }
    meterFill.style.width = `${Math.round(st.level * 100)}%`;
    meterFill.classList.toggle('hot', st.level > 0.92);
    sound.hidden = ended;
    test.hidden = !!engine.audio;
    audioMsg.textContent = localMsg || st.error;
    reading.el.hidden = ended;
    reading.paint();
    chat.paint();
    if (ended) paintAfter();
  };

  const off = engine.on(paint);
  const offDeck = deck.on(paint);
  const tick = setInterval(paint, 1000);
  root._dispose = () => { off(); offDeck(); clearInterval(tick); reading.dispose(); navigator.mediaDevices?.removeEventListener?.('devicechange', onDevices); };
  await loadInputs();
  paint();
  return root;
}

// Copies the thumbnail and the recording to the public bucket and puts them on the item.
async function publishReplay(itemId, cap, title) {
  needNet();
  if (!cap?.blob && !cap?.r2Key) throw new Error('There is no recording to publish.');
  const thumbKey = `thumbs/${itemId}.jpg`;
  const thumb = await thumbFromTitle(title || 'Live');
  await uploadBlob(thumbKey, thumb);
  const out = await liveAssets({ itemId, thumbKey, recordingKey: cap.r2Key });
  const { error } = await sb.from('published_items').update({
    public_media_key: out.publicMediaKey, public_thumb_key: out.publicThumbKey, media_key: cap.r2Key, thumb_key: thumbKey,
    mime: cap.mime, duration: cap.duration, status: 'published', updated_at: new Date().toISOString(),
  }).eq('id', itemId);
  if (error) throw error;
}