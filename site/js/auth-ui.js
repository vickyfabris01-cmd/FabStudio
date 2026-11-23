// Viewer accounts for the public site: email and password, Google, and the sign-in prompt shown before play, react or comment.
// There are no automatic guest sessions any more. Old guest sessions still merge into an account when their owner signs in.
import { CONFIG } from '../shared/config.js';
import { sbp } from '../shared/supabase-public.js';
import { h, toast } from '../shared/dom.js';

const STASH = 'fp.guest';
const listeners = new Set();
let session = null;
let googleReady = false;
let googleLoading = null;
let rawNonce = '';
let googleDone = null;
let merging = null;
let pwOpen = false;

export const getSession = () => session;
export const isGuest = () => !!session?.user?.is_anonymous;
export const isMember = () => !!session && !session.user.is_anonymous;
export function onAuth(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => listeners.forEach((fn) => { try { fn(session); } catch (e) { console.warn(e); } });
const inAppBrowser = () => /; wv\)|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent);
const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');

export const displayName = () => {
  const u = session?.user;
  if (!u) return '';
  if (u.is_anonymous) return `Guest ${u.id.slice(0, 4)}`;
  return u.user_metadata?.display_name || u.user_metadata?.full_name?.split(' ')[0] || (u.email || '').split('@')[0] || 'You';
};

/* ---------- start-up ---------- */
export async function initAuth() {
  const { data } = await sbp.auth.getSession();
  session = data.session;
  sbp.auth.onAuthStateChange((event, s) => {
    session = s;
    notify();
    // Never call Supabase inside this callback directly; defer it.
    if (event === 'PASSWORD_RECOVERY') setTimeout(() => passwordDialog('Choose a new password'), 0);
    if (event === 'SIGNED_IN') setTimeout(() => { mergeIfStashed(); }, 0);
  });
  mergeIfStashed();
  googleLoading = initGoogle();
  return session;
}

/* ---------- sign-in prompt ---------- */
const ASK = {
  listen: 'Sign in to listen', watch: 'Sign in to watch', react: 'Sign in to react', comment: 'Sign in to comment',
  join: 'Sign in to join the live', default: 'Sign in to continue',
};
let prompting = null;

// Used before play, a reaction or a comment. A signed-in person passes straight through. Anyone else gets a small
// prompt on the same page (Continue with Google, or email). Resolves with the session once they are signed in,
// or null if they close the prompt. Google keeps them on the page, so what they were doing carries on.
export function requireAuth(reason = 'default') {
  if (isMember()) return Promise.resolve(session);
  if (prompting) return prompting;
  prompting = new Promise((resolve) => {
    const back = location.pathname + location.search;
    const gbox = h('div', { class: 'gbox' });
    let off = () => {};
    const close = (result) => {
      off();
      document.removeEventListener('keydown', onKey);
      googleDone = null;
      wrap.remove();
      prompting = null;
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    const wrap = h('div', { class: 'invite', role: 'dialog', 'aria-modal': 'true', 'aria-label': ASK[reason] || ASK.default, onclick: (e) => { if (e.target === wrap) close(null); } },
      h('div', { class: 'invite-box' },
        h('button', { class: 'invite-x', type: 'button', 'aria-label': 'Close', onclick: () => close(null) }, '×'),
        h('h2', {}, ASK[reason] || ASK.default),
        h('p', {}, 'Create a free account, or sign in, to listen, watch, react and comment.'),
        gbox,
        h('div', { class: 'invite-go' },
          h('a', { class: 'btn-go', href: `/auth/?next=${encodeURIComponent(back)}` }, 'Sign in with email'),
          h('a', { class: 'btn-later', href: `/auth/signup/?next=${encodeURIComponent(back)}` }, 'Create account'))));
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    renderGoogleButton(gbox, () => {});
    off = onAuth((s) => { if (s && !s.user.is_anonymous) setTimeout(() => close(s), 0); });
  });
  return prompting;
}

/* ---------- Google ---------- */
function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

async function initGoogle() {
  if (!CONFIG.GOOGLE_CLIENT_ID) return;
  try {
    await loadGoogleScript();
    rawNonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const hashed = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawNonce))));
    window.google.accounts.id.initialize({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      callback: onGoogleCredential,
      nonce: hashed,
      use_fedcm_for_prompt: true,
      cancel_on_tap_outside: true,
      itp_support: true,
    });
    googleReady = true;
    // The automatic popup: only for visitors without an account, once per browser session.
    if ((!session || session.user.is_anonymous) && !sessionStorage.getItem('fp.prompted')) {
      sessionStorage.setItem('fp.prompted', '1');
      window.google.accounts.id.prompt();
    }
  } catch (e) {
    console.warn('Google sign-in is not available here', e);
  }
}

async function onGoogleCredential(resp) {
  try {
    await stashGuest();
    const { error } = await sbp.auth.signInWithIdToken({ provider: 'google', token: resp.credential, nonce: rawNonce });
    if (error) throw error;
    toast('Signed in.');
    await mergeIfStashed();
    if (googleDone) googleDone();
  } catch (e) {
    toast('Google sign-in failed: ' + (e.message || e));
  }
}

// Draws the Google button into el. Returns false when Google is not set up (no client ID yet).
export function renderGoogleButton(el, done, text = 'continue_with') {
  if (!CONFIG.GOOGLE_CLIENT_ID) return false;
  googleDone = done || null;
  (googleLoading || Promise.resolve()).then(() => {
    if (!googleReady) return;
    window.google.accounts.id.renderButton(el, {
      type: 'standard', theme: 'filled_black', size: 'large', text, shape: 'pill',
      width: Math.min(400, el.clientWidth || 300),
    });
  });
  if (inAppBrowser()) el.after(h('p', { class: 'muted small' }, 'Google sign-in can fail inside other apps. If it does, open this page in your browser, or use email.'));
  return true;
}

/* ---------- guest data follows the person into their account ---------- */
async function stashGuest() {
  const { data } = await sbp.auth.getSession();
  const s = data.session;
  if (s?.user?.is_anonymous) localStorage.setItem(STASH, JSON.stringify({ id: s.user.id, refresh: s.refresh_token }));
}

// The guest's access token may have expired while waiting for an email link, so trade the refresh token for a new one.
async function freshGuestToken(refresh) {
  const r = await fetch(CONFIG.SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { apikey: CONFIG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!r.ok) return null;
  return (await r.json()).access_token || null;
}

function mergeIfStashed() {
  if (merging) return merging;
  merging = (async () => {
    const raw = localStorage.getItem(STASH);
    if (!raw) return;
    let guest;
    try { guest = JSON.parse(raw); } catch { localStorage.removeItem(STASH); return; }
    const { data } = await sbp.auth.getSession();
    const s = data.session;
    if (!s || s.user.is_anonymous) return; // still a guest: keep waiting
    localStorage.removeItem(STASH);
    if (s.user.id === guest.id) return;
    try {
      const token = await freshGuestToken(guest.refresh);
      if (!token) return;
      const r = await fetch(CONFIG.API_BASE + '/viewer/merge', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestToken: token }),
      });
      if (r.ok) { toast('Your views, reactions and comments moved to your account.'); notify(); }
    } catch { /* the guest data simply stays with the guest account */ }
  })().finally(() => { merging = null; });
  return merging;
}

/* ---------- email ---------- */
export async function emailSignIn(email, password) {
  await stashGuest();
  const { error } = await sbp.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await mergeIfStashed();
}

// Returns 'done' when the account is ready now, or 'confirm' when the person must tap the email link first.
export async function emailCreate(email, password, redirect) {
  await stashGuest();
  const { data, error } = await sbp.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
  if (error) throw error;
  // An address that already has an account comes back with no identities and no error.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('That email already has an account. Sign in instead.');
  }
  if (data.session) { await mergeIfStashed(); return 'done'; }
  return 'confirm';
}

export async function resetPassword(email) {
  const { error } = await sbp.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' });
  if (error) throw error;
}

/* ---------- new password after a reset link ---------- */
function passwordDialog(title) {
  if (pwOpen) return;
  pwOpen = true;
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (8+ characters)', 'aria-label': 'New password' });
  const again = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again', 'aria-label': 'Confirm new password' });
  const msg = h('p', { class: 'error', role: 'alert' });
  const dlg = h('dialog', { class: 'sheet' }, h('div', { class: 'sheet-body' }, h('h2', {}, title), pw, again, msg,
    h('button', { class: 'btn primary', onclick: async () => {
      if (pw.value.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
      if (pw.value !== again.value) { msg.textContent = "The passwords don't match."; return; }
      const { error } = await sbp.auth.updateUser({ password: pw.value });
      if (error) { msg.textContent = error.message; return; }
      toast('Password saved.');
      dlg.close();
    } }, 'Save password')));
  dlg.addEventListener('close', () => { pwOpen = false; dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
}

/* ---------- profile page ---------- */
// Changes the name shown on comments and in the header. The database renames old comments too.
export async function updateDisplayName(name) {
  const { data, error } = await sbp.rpc('set_display_name', { p_name: name });
  if (error) throw error;
  const { error: e2 } = await sbp.auth.updateUser({ data: { display_name: data } });
  if (e2) throw e2;
  return data;
}

export async function signOutNow() {
  await sbp.auth.signOut();
}

// Removes the account and everything the person wrote, then ends the session on this device.
export async function deleteMyAccount() {
  const { error } = await sbp.rpc('delete_my_account');
  if (error) throw error;
  await sbp.auth.signOut({ scope: 'local' }).catch(() => {});
}

export const signInMethod = () => {
  const ids = session?.user?.identities || [];
  return ids.some((i) => i.provider === 'google') ? 'Google' : 'Email and password';
};

/* ---------- header chip ---------- */
// A signed-in person's name opens /profile/. Pass { newTab: true } where leaving the page would be rude (the live room).
export function mountAccountChip(el, { newTab = false } = {}) {
  const paint = () => {
    el.textContent = isMember() ? displayName() : 'Sign in';
    el.setAttribute('aria-label', isMember() ? `Your profile, ${displayName()}` : 'Sign in');
  };
  el.addEventListener('click', () => {
    if (isMember()) { if (newTab) window.open('/profile/', '_blank', 'noopener'); else location.assign('/profile/'); }
    else location.assign('/auth/?next=' + encodeURIComponent(location.pathname + location.search));
  });
  onAuth(paint);
  paint();
}
