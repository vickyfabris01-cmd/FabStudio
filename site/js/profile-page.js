// The profile page (/profile/): change your name, sign out, delete your account.
import { initAuth, isMember, getSession, displayName, onAuth, updateDisplayName, signOutNow, deleteMyAccount, signInMethod } from './auth-ui.js';
import { h, toast } from '../shared/dom.js';

const $ = (id) => document.getElementById(id);

function say(text, ok) {
  const m = $('msg');
  m.textContent = text || '';
  m.className = ok ? 'muted' : 'error';
}

function friendly(e) {
  const m = String(e?.message || e || '');
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection. Please try again.';
  if (/bad name/i.test(m)) return 'Use 1 to 30 characters for your name.';
  if (/not signed in/i.test(m)) return 'Please sign in again.';
  if (/owner account/i.test(m)) return 'This account cannot be deleted here.';
  if (/function .* does not exist|schema cache/i.test(m)) return 'This feature is not set up yet. The database update has not been run.';
  return m || 'Something went wrong.';
}

function confirmDelete() {
  const box = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'Type DELETE', 'aria-label': 'Type DELETE to confirm' });
  const msg = h('p', { class: 'error', role: 'alert' });
  const go = h('button', { class: 'btn danger-btn', type: 'button', disabled: true }, 'Delete forever');
  const dlg = h('dialog', { class: 'sheet' }, h('div', { class: 'sheet-body' },
    h('h2', {}, 'Delete your account?'),
    h('p', { class: 'muted' }, 'Your account, comments, reactions and views will be removed for good. This cannot be undone.'),
    box, msg, go,
    h('button', { class: 'btn link', type: 'button', onclick: () => dlg.close() }, 'Cancel')));
  box.addEventListener('input', () => { go.disabled = box.value.trim().toUpperCase() !== 'DELETE'; });
  go.addEventListener('click', async () => {
    go.disabled = true; box.disabled = true;
    msg.textContent = '';
    try {
      await deleteMyAccount();
      location.replace('/');
    } catch (e) {
      msg.textContent = friendly(e);
      box.disabled = false; go.disabled = false;
    }
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

async function main() {
  await initAuth();
  if (!isMember()) { location.replace('/auth/?next=' + encodeURIComponent('/profile/')); return; }
  const u = getSession().user;
  $('who').textContent = `${u.email || 'Signed in'} · ${signInMethod()}`;
  $('name').value = displayName();
  $('main').hidden = false;
  $('back').addEventListener('click', (e) => { if (history.length > 1) { e.preventDefault(); history.back(); } });

  $('nameform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('name').value.trim();
    say('');
    if (!name) return say('Enter a name.');
    if (name.length > 30) return say('Use 30 characters or fewer.');
    const btn = $('save');
    btn.disabled = true;
    say('Saving…', true);
    try {
      const saved = await updateDisplayName(name);
      $('name').value = saved;
      say('');
      toast('Name saved.');
    } catch (err) { say(friendly(err)); }
    btn.disabled = false;
  });

  $('out').addEventListener('click', async () => {
    $('out').disabled = true;
    try { await signOutNow(); } catch { /* the session is cleared on this device either way */ }
    location.replace('/');
  });

  $('del').addEventListener('click', confirmDelete);
  onAuth((s) => { if (!s) location.replace('/'); });
}
main();
