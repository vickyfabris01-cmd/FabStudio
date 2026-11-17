// The Live tab: your sessions, scheduling, the on-air console, and publishing the replay afterwards.
import { sb } from '../../shared/supabase.js';
import { FIELDS, DEFAULT_SETTINGS } from '../../shared/live-settings.js';
import { db, uid, now } from './db.js';
import { h, fmtDur, fmtAgo, toast, openModal } from './ui.js';
import { engine } from './live-engine.js';
import { listInputs } from './live-audio.js';
import { uploadBlob, liveAssets } from './api.js';
import { thumbFromTitle } from './thumbs.js';
import { syncAndWait } from './sync.js';

const needNet = () => { if (!navigator.onLine) throw new Error('This needs internet.'); };
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const SITE = () => location.origin;

/* ---------- create / schedule ---------- */
async function createSession({ title, description, startsAt }) {
  needNet();
  const id = uid();
  const t = now();
  const { error: e1 } = await sb.from('published_items').insert({
    id, kind: 'live', title, description, status: 'published', published_at: t, mime: null,
    comments_enabled: true, reactions_enabled: true, created_at: t, updated_at: t,
  });
  if (e1) throw e1;
  const { error: e2 } = await sb.from('live_sessions').insert({ item_id: id, state: 'scheduled', starts_at: startsAt || null, settings: DEFAULT_SETTINGS });
  if (e2) { await sb.from('published_items').delete().eq('id', id); throw e2; }
  return id;
}

function newLiveModal(nav) {
  const title = h('input', { placeholder: 'Title viewers will see', maxlength: 120 });
  const desc = h('textarea', { rows: 2, placeholder: 'A line about it (optional)' });
  const when = h('input', { type: 'datetime-local' });
  const err = h('p', { class: 'error' });
  const go = h('button', { class: 'btn primary', type: 'button' }, 'Create');
  const { close, box } = openModal(h('h3', {}, 'New live'), title, h('div', { style: 'height:.5rem' }), desc,
    h('label', { class: 'small muted' }, 'Planned start (optional). It only shows a countdown. You still press Go live.'), when, err,
    h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'), h('span', { class: 'grow' }), go));
  go.onclick = async () => {
    err.textContent = '';
    if (!title.value.trim()) { err.textContent = 'Give it a title.'; return; }
    go.disabled = true;
    try {
      const id = await createSession({ title: title.value.trim(), description: desc.value.trim(), startsAt: when.value ? new Date(when.value).toISOString() : null });
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
const mmss = (s) => { s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export async function liveConsoleView(itemId, nav) {
  const root = h('div', { class: 'console' });
  try { await engine.open(itemId); }
  catch (e) { root.append(h('p', { class: 'error' }, e.message || String(e)), h('button', { class: 'btn', onclick: () => nav.liveList() }, 'Back')); return root; }

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

  /* audio card */
  const sel = h('select', { 'aria-label': 'Audio input' });
  const meterFill = h('div', { class: 'meter-fill' });
  const gain = h('input', { type: 'range', min: 0, max: 2, step: 0.05, value: 1, 'aria-label': 'Input gain' });
  gain.oninput = () => engine.audio?.setGain(Number(gain.value));
  const mon = h('input', { type: 'checkbox' });
  mon.onchange = () => engine.audio?.setMonitor(mon.checked);
  const audioMsg = h('p', { class: 'small error' });
  els.go = h('button', { class: 'btn primary big', type: 'button' }, 'Go live');
  els.retry = h('button', { class: 'btn', type: 'button', hidden: true }, 'Retry audio');
  els.rec = h('span', { class: 'small muted' });
  const loadInputs = async () => {
    try { inputs = await listInputs(); } catch { inputs = []; }
    sel.replaceChildren(h('option', { value: '' }, 'Default input'), ...inputs.map((i) => h('option', { value: i.id }, i.label)));
    sel.value = engine.deviceId || '';
  };
  sel.onchange = async () => { try { await engine.prepare(sel.value); } catch (e) { audioMsg.textContent = e.message; } };
  const test = h('button', { class: 'btn', type: 'button' }, 'Open soundcard');
  test.onclick = async () => { audioMsg.textContent = ''; try { await engine.prepare(sel.value); await loadInputs(); } catch (e) { audioMsg.textContent = e.name === 'NotAllowedError' ? 'The browser blocked the microphone.' : (e.message || String(e)); } };
  els.go.onclick = async () => {
    els.go.disabled = true;
    try { await engine.goLive(); } catch (e) { toast(e.message || 'Could not go live'); }
    els.go.disabled = false;
  };
  els.retry.onclick = () => engine.retryAudio();
  const endBtn = h('button', { class: 'btn danger', type: 'button', hidden: true }, 'End live');
  endBtn.onclick = () => { if (confirm('End the live for everyone? This cannot be undone.')) engine.end(); };
  const audioCard = h('section', { class: 'card c-audio' },
    h('h3', {}, 'Sound'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, sel), test),
    h('div', { class: 'meter' }, meterFill),
    h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'Gain'), h('div', { class: 'grow' }, gain)),
    h('label', { class: 'row check small' }, mon, h('span', {}, 'Hear what viewers hear (use headphones, or it will echo)')),
    audioMsg, els.rec,
    h('div', { class: 'row', style: 'margin-top:.6rem' }, els.go, els.retry, endBtn));

  /* chat */
  const chatBox = h('div', { class: 'chat-list', role: 'log' });
  const pinned = h('div', { class: 'pinned small', hidden: true });
  const chatIn = h('input', { placeholder: 'Say something as the host…', maxlength: 300 });
  const sendChat = () => { const t = chatIn.value.trim(); if (t) { engine.send({ t: 'chat', text: t }); chatIn.value = ''; } };
  chatIn.onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  const muteIn = h('input', { placeholder: 'Mute by ID (e.g. a1b2)', class: 'inline' });
  const muteBtn = h('button', { class: 'btn small', type: 'button', onclick: () => { if (muteIn.value.trim()) { engine.send({ t: 'mute', uid: muteIn.value.trim(), on: true }); muteIn.value = ''; } } }, 'Mute');
  els.pause = h('button', { class: 'btn small', type: 'button', onclick: () => engine.send({ t: 'pause', on: !s().room?.chatPaused }) }, 'Pause chat');
  const slow = h('select', { class: 'inline', 'aria-label': 'Slow mode' }, [0, 5, 10, 30, 60].map((n) => h('option', { value: n }, n ? `Slow ${n}s` : 'No slow mode')));
  slow.onchange = () => engine.saveSettings({ slowSeconds: Number(slow.value) });
  els.muted = h('div', { class: 'small muted' });
  const chatCard = h('section', { class: 'card c-chat' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Chat'), els.pause, slow), pinned, chatBox,
    h('div', { class: 'row' }, h('div', { class: 'grow' }, chatIn), h('button', { class: 'btn small', type: 'button', onclick: sendChat }, 'Send')),
    h('div', { class: 'row', style: 'margin-top:.4rem' }, h('div', { class: 'grow' }, muteIn), muteBtn), els.muted);

  /* requests */
  const reqBox = h('div', { class: 'req-list' });
  const reqCard = h('section', { class: 'card c-req' }, h('h3', {}, 'Requests'), reqBox);

  /* settings */
  const setBox = h('div', { class: 'set-list' });
  const setCard = h('details', { class: 'card c-set' }, h('summary', {}, 'Live settings'), setBox);

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
    const live = st.phase === 'live';
    const ended = st.phase === 'ended';
    els.status.textContent = live ? '● ON AIR' : ended ? 'Ended' : st.phase === 'starting' ? 'Starting…' : 'Not on air';
    els.status.className = 'badge' + (live ? ' onair' : '');
    els.timer.textContent = live && st.room?.startedAt ? mmss((Date.now() - st.room.startedAt) / 1000) : '';
    const shown = st.watching == null ? '–' : st.watching;
    els.watch.textContent = `Watching: ${shown}${st.peak ? ` · peak ${st.peak}` : ''} · Love ${st.pulses.love} · Like ${st.pulses.like}`;
    els.conn.textContent = { open: 'Room connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', closed: '' }[st.conn] || '';
    meterFill.style.width = `${Math.round(st.level * 100)}%`;
    meterFill.classList.toggle('hot', st.level > 0.92);
    els.go.hidden = live || ended; els.go.disabled = st.conn !== 'open' || st.phase === 'starting';
    endBtn.hidden = !live;
    els.retry.hidden = !(live && st.audioState === 'lost');
    audioCard.hidden = ended; setCard.hidden = false;
    els.rec.textContent = live ? `Recording on this laptop · ${fmtDur(st.recSeconds)}${st.audioState === 'connecting' ? ' · reconnecting audio…' : ''}` : '';
    if (st.error && !audioMsg.textContent) audioMsg.textContent = st.error; else if (!st.error) audioMsg.textContent = audioMsg.dataset.local || '';
    if (document.activeElement !== titleIn) titleIn.value = st.row.title;
    // chat
    const room = st.room;
    pinned.hidden = !room?.pinned;
    if (room?.pinned) pinned.replaceChildren(h('b', {}, 'Pinned: '), room.pinned.text, ' ', h('button', { class: 'lnk', type: 'button', onclick: () => engine.send({ t: 'pin' }) }, 'unpin'));
    els.pause.textContent = room?.chatPaused ? 'Resume chat' : 'Pause chat';
    if (document.activeElement !== slow) slow.value = String(st.row.settings.slowSeconds);
    const mk = (room?.muted || []).join(',');
    if (els.muted.dataset.k !== mk) {
      els.muted.dataset.k = mk;
      els.muted.replaceChildren(...(room?.muted?.length ? ['Muted: ', ...room.muted.flatMap((m) => [h('button', { class: 'lnk', type: 'button', title: 'Unmute', onclick: () => engine.send({ t: 'mute', uid: m, on: false }) }, m.slice(0, 4) + ' ✕'), ' '])] : []));
    }
    const n = st.chat.length + ':' + (st.chat[st.chat.length - 1]?.id || '');
    if (n !== lastChatN) {
      const atEnd = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 60;
      chatBox.replaceChildren(...st.chat.map(chatLine));
      if (atEnd) chatBox.scrollTop = chatBox.scrollHeight;
      lastChatN = n;
    }
    // requests
    const rk = JSON.stringify((room?.requests || []).map((r) => [r.id, r.status]));
    if (rk !== lastReqKey) {
      const list = (room?.requests || []).filter((r) => r.status !== 'dismissed');
      reqBox.replaceChildren(...(list.length ? list.map(reqLine) : [h('p', { class: 'muted small' }, 'Nothing yet.')]));
      lastReqKey = rk;
    }
    // settings (redrawn only when they change and nothing inside is being edited)
    const sk = JSON.stringify(st.row.settings);
    if (sk !== lastSetKey && !setBox.contains(document.activeElement)) {
      let group = '';
      setBox.replaceChildren(...FIELDS.flatMap((f) => { const out = []; if (f.group !== group) { group = f.group; out.push(h('h4', {}, group)); } out.push(field(f)); return out; }));
      lastSetKey = sk;
    }
    if (ended) paintAfter();
  };

  /* ----- after the session ----- */
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

  const off = engine.on(paint);
  const tick = setInterval(paint, 1000);
  root._dispose = () => { off(); clearInterval(tick); };
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