// The console header: back to Lives, title, ON AIR, clock, End live, viewer link, gear.
import { h, fmtDur, toast, gearIcon, linkIcon } from '../ui.js';

const clock = (s) => { s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export const viewerLink = (itemId) => `${location.origin}/live/?id=${itemId}`;
export async function copyLink(itemId) {
  const link = viewerLink(itemId);
  try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch { prompt('Viewer link', link); }
}

export function consoleHeader({ engine, nav, itemId, openSettings }) {
  const titleIn = h('input', { class: 'inline c-title', value: engine.s.row.title, maxlength: 120, 'aria-label': 'Title viewers see' });
  titleIn.onchange = () => engine.saveTitle(titleIn.value).catch((e) => toast(e.message));
  const status = h('span', { class: 'badge' });
  const timer = h('b', { class: 'c-clock' });
  const info = h('span', { class: 'small muted' });
  const retry = h('button', { class: 'btn small', type: 'button', hidden: true, onclick: () => engine.retryAudio() }, 'Retry audio');
  const end = h('button', { class: 'btn small danger', type: 'button', hidden: true }, 'End live');
  end.onclick = () => { if (confirm('End the live for everyone? This cannot be undone.')) engine.end(); };
  const link = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Copy viewer link', title: 'Copy viewer link', onclick: () => copyLink(itemId) }, linkIcon());
  const gear = h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Live settings', title: 'Live settings', onclick: openSettings }, gearIcon());
  const el = h('div', { class: 'card c-head' },
    h('div', { class: 'row c-headrow' },
      h('button', { class: 'btn small', type: 'button', onclick: () => nav.liveList() }, '‹ Lives'),
      h('div', { class: 'grow' }, titleIn), status, timer, retry, end, link, gear),
    h('div', { class: 'row small' }, info));

  function paint() {
    const st = engine.s;
    const live = st.phase === 'live';
    status.textContent = live ? '● ON AIR' : st.phase === 'ended' ? 'Ended' : st.phase === 'starting' ? 'Starting…' : 'Not on air';
    status.className = 'badge' + (live ? ' onair' : '');
    timer.textContent = live && st.room?.startedAt ? clock((Date.now() - st.room.startedAt) / 1000) : '';
    end.hidden = !live;
    retry.hidden = !(live && st.audioState === 'lost');
    const conn = { open: '', connecting: 'Connecting to the room…', reconnecting: 'Reconnecting to the room…', closed: '' }[st.conn] || '';
    const rec = live ? `Recording on this laptop · ${fmtDur(st.recSeconds)}${st.audioState === 'connecting' ? ' · reconnecting audio…' : ''}` : '';
    info.textContent = [rec, conn].filter(Boolean).join('  ·  ');
    if (document.activeElement !== titleIn) titleIn.value = st.row.title;
  }
  return { el, paint };
}
