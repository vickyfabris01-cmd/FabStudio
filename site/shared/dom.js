// Small helpers for the public site (kept separate from FabStudio so viewers never load studio code).
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'selected', 'disabled'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

export const fmtDur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let timer;
export function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('show'), 4000);
}
