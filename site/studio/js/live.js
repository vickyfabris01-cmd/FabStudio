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
import { recapPane } from './console/recap.js';
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
  const els = {};
  let inputs = [];
  let lastChatN = -1; let lastReqKey = ''; let lastSetKey = '';

  /* header */
  const titleIn = h('input', { class: 'inline', value: s().row.title, maxlength: 120, 'aria-label': 'Title viewers see' });
  titleIn.onchange = () => engine.saveTitle(titleIn.value).catch((e) => toast(e.message));
  els.status = h('span', { class: 'badge' }); els.timer = h('b', {}); els.watch = h('span', { class: 'muted small' }); els.conn = h('span', { class: 'small muted' });
  const link = `${SITE()}/live/?id=${itemId}`;
  const head = h('div', { class: 'c-head' },
    h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => nav.liveList() }, '‹ Lives'), h('span', { class: 'grow' }), els.status, els.timer),
    h('div', { class: 'row', style: 'margin-top:.5rem' }, titleIn),
    h('div', { class: 'row small', style: 'margin-top:.4rem' }, els.watch, h('span', { class: 'grow' }), els.conn,
      h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch { prompt('Viewer link', link); } } }, 'Copy viewer link')));

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

  /* after the session */
  const afterBox = h('section', { class: 'card c-after', hidden: true });

  root.append(head, h('div', { class: 'c-grid' }, h('div', { class: 'c-col' }, audioCard, reqCard, setCard, afterBox), h('div', { class: 'c-col' }, chatCard)));

  /* ----- painting ----- */
  const chatLine = (c) => {
    const who = c.host ? h('b', { class: 'host' }, c.name) : h('b', {}, c.name, h('span', { class: 'muted' }, ` ·${c.uid8}`));
    const menu = h('span', { class: 'cmenu' },
      h('button', { class: 'lnk', type: 'button', title: 'Pin', onclick: () => engine.send({ t: 'pin', msgId: c.id }) }, 'pin'),
      h('button', { class: 'lnk', type: 'button', title: 'Mute this person', onclick: () => engine.send({ t: 'mute', uid: c.uid8, on: true }) }, 'mute'),
      h('button', { class: 'lnk', type: 'button', title: 'Delete', onclick: () => engine.send({ t: 'delchat', id: c.id }) }, 'delete'));
    return h('div', { class: 'cline' }, who, ' ', h('span', {}, c.text), menu);
  };
  const reqLine = (r) => {
    const act = (a, l) => h('button', { class: 'btn small', type: 'button', onclick: () => engine.send({ t: 'req', id: r.id, action: a }) }, l);
    return h('div', { class: 'rline' + (r.status === 'reading' ? ' now' : '') + (r.status === 'done' ? ' done' : '') },
      h('div', { class: 'grow' }, h('span', { class: 'badge' }, 'poem'), ' ', h('span', {}, r.text), h('div', { class: 'small muted' }, `${r.name} ·${(r.uid || '').slice(0, 4)}`)),
      r.status === 'reading' ? act('done', 'Done') : [act('reading', 'Reading'), r.status === 'done' ? act('queue', 'Requeue') : act('up', '↑')], act('dismiss', '✕'));
  };
  const field = (f) => {
    const v = s().row.settings[f.key];
    let input;
    if (f.type === 'bool') { input = h('input', { type: 'checkbox', checked: !!v }); input.onchange = () => engine.saveSettings({ [f.key]: input.checked }); }
    else if (f.type === 'choice') {
      input = h('select', {}, f.options.map(([val, l]) => h('option', { value: val, selected: String(val) === String(v) }, l)));
      input.onchange = () => engine.saveSettings({ [f.key]: f.number ? Number(input.value) : input.value });
    } else {
      input = h('input', { type: f.type === 'int' ? 'number' : 'text', value: v, min: f.min, max: f.max, class: 'inline' });
      input.onchange = () => engine.saveSettings({ [f.key]: f.type === 'int' ? Number(input.value) : input.value });
    }
    return h('label', { class: 'sfield' + (f.type === 'bool' ? ' row check' : '') }, f.type === 'bool' ? [input, h('span', {}, f.label)] : [h('span', {}, f.label + (f.unit ? ` (${f.unit})` : '')), input], f.hint ? h('div', { class: 'small muted' }, f.hint) : null);
  };

  const paint = () => {
    const st = s();
    const ended = st.phase === 'ended';
    els.status.textContent = live ? '● ON AIR' : ended ? 'Ended' : st.phase === 'starting' ? 'Starting…' : 'Not on air';
    els.status.className = 'badge' + (live ? ' onair' : '');
    els.timer.textContent = live && st.room?.startedAt ? mmss((Date.now() - st.room.startedAt) / 1000) : '';
    const shown = st.watching == null ? '–' : st.watching;
    els.watch.textContent = `Watching: ${shown}${st.peak ? ` · peak ${st.peak}` : ''} · Love ${st.pulses.love} · Like ${st.pulses.like}`;
    els.conn.textContent = { open: 'Room connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', closed: '' }[st.conn] || '';
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
  root._dispose = () => { off(); offDeck(); clearInterval(tick); reading.dispose(); recap?.dispose(); navigator.mediaDevices?.removeEventListener?.('devicechange', onDevices); };
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