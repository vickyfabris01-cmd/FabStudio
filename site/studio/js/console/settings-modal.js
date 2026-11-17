// The live settings list, drawn from the shared FIELDS (the same list the Worker validates). It is used twice:
// in the "New live" step (values are the ones being chosen) and in the gear modal during the live (changes apply
// at once through engine.saveSettings). Chat moderation (pause, mute by ID) sits at the end of the modal.
import { FIELDS } from '../../../shared/live-settings.js';
import { h, openModal } from '../ui.js';
import { engine } from '../live-engine.js';

// values: current settings object. onChange(patch) is called with one changed key. skip: groups to leave out.
export function settingsList(values, onChange, { skip = [] } = {}) {
  const box = h('div', { class: 'set-list' });
  let group = '';
  for (const f of FIELDS) {
    if (skip.includes(f.group)) continue;
    if (f.group !== group) { group = f.group; box.append(h('h4', {}, group)); }
    const v = values[f.key];
    let input;
    if (f.type === 'bool') {
      input = h('input', { type: 'checkbox', checked: !!v });
      input.onchange = () => onChange({ [f.key]: input.checked });
    } else if (f.type === 'choice') {
      input = h('select', {}, f.options.map(([val, l]) => h('option', { value: val, selected: String(val) === String(v) }, l)));
      input.onchange = () => onChange({ [f.key]: f.number ? Number(input.value) : input.value });
    } else {
      input = h('input', { type: f.type === 'int' ? 'number' : 'text', value: v, min: f.min, max: f.max, class: 'inline' });
      input.onchange = () => onChange({ [f.key]: f.type === 'int' ? Number(input.value) : input.value });
    }
    box.append(h('label', { class: 'sfield' + (f.type === 'bool' ? ' row check' : '') },
      f.type === 'bool' ? [input, h('span', {}, f.label)] : [h('span', {}, f.label + (f.unit ? ` (${f.unit})` : '')), input],
      f.hint ? h('span', { class: 'small muted' }, f.hint) : null));
  }
  return box;
}

// Pause chat and mute by ID: the host controls that used to sit on the chat card.
function moderation() {
  const pause = h('button', { class: 'btn small', type: 'button', onclick: () => engine.send({ t: 'pause', on: !engine.s.room?.chatPaused }) });
  const muteIn = h('input', { placeholder: 'Mute by ID (e.g. a1b2)', class: 'inline' });
  const doMute = () => { if (muteIn.value.trim()) { engine.send({ t: 'mute', uid: muteIn.value.trim(), on: true }); muteIn.value = ''; } };
  muteIn.onkeydown = (e) => { if (e.key === 'Enter') doMute(); };
  const muted = h('div', { class: 'small muted' });
  const el = h('div', { class: 'set-list' }, h('h4', {}, 'Moderation'),
    h('div', { class: 'row' }, pause, h('span', { class: 'small muted' }, 'Stops all writing for a moment')),
    h('div', { class: 'row', style: 'margin-top:.5rem' }, h('div', { class: 'grow' }, muteIn), h('button', { class: 'btn small', type: 'button', onclick: doMute }, 'Mute')), muted);
  let key = '';
  const paint = () => {
    const room = engine.s.room;
    pause.textContent = room?.chatPaused ? 'Resume chat' : 'Pause chat';
    const k = (room?.muted || []).join(',') + '|' + room?.chatPaused;
    if (k === key) return;
    key = k;
    muted.replaceChildren(...(room?.muted?.length ? ['Muted: ', ...room.muted.flatMap((m) => [h('button', { class: 'lnk', type: 'button', title: 'Unmute', onclick: () => engine.send({ t: 'mute', uid: m, on: false }) }, m.slice(0, 4)), ' '])] : []));
  };
  return { el, paint };
}

export function openSettingsModal() {
  const mod = moderation();
  const done = h('button', { class: 'btn primary', type: 'button' }, 'Done');
  const { close, box } = openModal(h('h3', {}, 'Live settings'),
    h('p', { class: 'small muted' }, 'Changes apply at once.'),
    settingsList(engine.s.row.settings, (patch) => engine.saveSettings(patch).catch(() => {})), mod.el,
    h('div', { class: 'row', style: 'justify-content:flex-end' }, done));
  box.classList.add('wide');
  done.onclick = () => close();
  const off = engine.on(mod.paint);
  box.addEventListener('modal-close', off);
  mod.paint();
}
