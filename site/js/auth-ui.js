// Viewer accounts: Google (automatic popup + button), email and password, guest, and guest-to-account merge.
import { CONFIG } from '../shared/config.js';
import { sbp } from '../shared/supabase-public.js';
import { h, toast } from '../shared/dom.js';
import { saveNickname, getNickname } from './data.js';

const STASH = 'fp.guest';
const listeners = new Set();
let session = null;
let googleReady = false;
let googleLoading = null;
let rawNonce = '';
let sheet = null;
let merging = null;
let pwOpen = false;

export const getSession = () => session;
export const isGuest = () => !!session?.user?.is_anonymous;
export function onAuth(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => listeners.forEach((fn) => { try { fn(session); } catch (e) { console.warn(e); } });
const inAppBrowser = () => /; wv\)|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent);
const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');

export const displayName = () => {
  const u = session?.user;
  if (!u) return '';
  if (u.is_anonymous) return getNickname() || 'Guest';
  return getNickname() || u.user_metadata?.full_name?.split(' ')[0] || (u.email || '').split('@')[0] || 'You';
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
    if (event === 'SIGNED_IN') setTimeout(() => { mergeIfStashed(); checkNeedsPassword(); }, 0);
  });
  await mergeIfStashed();
  checkNeedsPassword();
  googleLoading = initGoogle();
  return session;
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
    // The automatic popup: only for visitors with no session, once per browser session.
    if (!session && !sessionStorage.getItem('fp.prompted')) {
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
    closeSheet();
    toast('Signed in.');
    await mergeIfStashed();
  } catch (e) {
    toast('Google sign-in failed: ' + (e.message || e));
  }
}

/* ---------- guest data follows the person into their account ---------- */
async function stashGuest() {
  const { data } = await sbp.auth.getSession();
  const s = data.session;
  if (s?.user?.is_anonymous) sessionStorage.setItem(STASH, JSON.stringify({ id: s.user.id, token: s.access_token }));
}

function mergeIfStashed() {
  if (merging) return merging;
  merging = (async () => {
    const raw = sessionStorage.getItem(STASH);
    if (!raw) return;
    let guest;
    try { guest = JSON.parse(raw); } catch { sessionStorage.removeItem(STASH); return; }
    const { data } = await sbp.auth.getSession();
    const s = data.session;
    if (!s || s.user.is_anonymous) return; // still a guest: keep waiting
    sessionStorage.removeItem(STASH);
    if (s.user.id === guest.id) return;
    try {
      const r = await fetch(CONFIG.API_BASE + '/viewer/merge', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestToken: guest.token }),
      });
      if (r.ok) { toast('Your reactions and comments moved to your account.'); notify(); }
    } catch { /* the guest data simply stays with the guest account */ }
  })().finally(() => { merging = null; });
  return merging;
}

/* ---------- email and guest ---------- */
export async function continueAsGuest() {
  const { error } = await sbp.auth.signInAnonymously();
  if (error) throw error;
}

async function emailSignIn(email, password) {
  await stashGuest();
  const { error } = await sbp.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await mergeIfStashed();
}

async function emailCreate(email, password) {
  const redirect = location.origin + location.pathname + location.search;
  if (isGuest()) {
    // Same account, so everything the guest did is kept. A password is chosen after the email is confirmed.
    const { error } = await sbp.auth.updateUser({ email, data: { needs_password: true } }, { emailRedirectTo: redirect });
    if (error) {
      if (/already|exists|registered/i.test(error.message || error.code || '')) throw new Error('That email already has an account. Use Sign in and your reactions will move across.');
      throw error;
    }
    return 'Check your email and tap the link. Then you will choose a password.';
  }
  if (password.length < 8) throw new Error('Use at least 8 characters for the password.');
  const { data, error } = await sbp.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
  if (error) throw error;
  return data.session ? 'Account created.' : 'Check your email to confirm your account.';
}

async function resetPassword(email) {
  const { error } = await sbp.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/' });
  if (error) throw error;
}

/* ---------- password dialog (after recovery link or after confirming an email) ---------- */
function checkNeedsPassword() {
  const u = session?.user;
  if (u && !u.is_anonymous && u.email && u.user_metadata?.needs_password) passwordDialog('Choose a password for your account');
}

function passwordDialog(title) {
  if (pwOpen) return;
  pwOpen = true;
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New password (8+ characters)', minlength: 8 });
  const msg = h('p', { class: 'error', role: 'alert' });
  const dlg = h('dialog', { class: 'sheet' }, h('h2', {}, title), pw, msg,
    h('button', { class: 'btn primary', onclick: async () => {
      if (pw.value.length < 8) { msg.textContent = 'Use at least 8 characters.'; return; }
      const { error } = await sbp.auth.updateUser({ password: pw.value, data: { needs_password: false } });
      if (error) { msg.textContent = error.message; return; }
      toast('Password saved.');
      dlg.close();
    } }, 'Save password'));
  dlg.addEventListener('close', () => { pwOpen = false; dlg.remove(); });
  document.body.append(dlg);
  dlg.showModal();
}

/* ---------- the sign-in sheet ---------- */
export function closeSheet() { sheet?.close(); }

export function openSheet(reason = '') {
  closeSheet();
  const dlg = h('dialog', { class: 'sheet' });
  sheet = dlg;
  dlg.addEventListener('close', () => { if (sheet === dlg) sheet = null; dlg.remove(); });
  const body = h('div', { class: 'sheet-body' });
  dlg.append(body);
  document.body.append(dlg);
  paintSheet(body, reason);
  dlg.showModal();
  return dlg;
}

function paintSheet(body, reason) {
  const msg = h('p', { class: 'muted', role: 'status' });
  const say = (t, bad) => { msg.textContent = t; msg.className = bad ? 'error' : 'muted'; };
  const close = h('button', { class: 'btn link', onclick: closeSheet }, 'Close');

  // Signed in with a real account
  if (session && !session.user.is_anonymous) {
    const nick = h('input', { value: getNickname() || displayName(), maxlength: 30, 'aria-label': 'Nickname' });
    body.replaceChildren(
      h('h2', {}, 'Your account'),
      h('p', { class: 'muted' }, session.user.email || 'Signed in with Google'),
      h('label', {}, h('span', { class: 'muted small' }, 'Nickname shown on your comments'), nick),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => { const n = nick.value.trim(); if (n) { await saveNickname(n); notify(); toast('Saved.'); } } }, 'Save'),
        h('button', { class: 'btn', onclick: async () => { await sbp.auth.signOut(); closeSheet(); toast('Signed out.'); } }, 'Sign out')),
      close);
    return;
  }

  const guest = isGuest();
  const email = h('input', { type: 'email', autocomplete: 'email', placeholder: 'Email', 'aria-label': 'Email' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: guest ? 'Password (only for signing in)' : 'Password', 'aria-label': 'Password' });
  const run = (fn) => async () => {
    try { say('One moment…'); await fn(); } catch (e) { say(e.message || String(e), true); }
  };
  const gbox = h('div', { class: 'gbox' });
  if (CONFIG.GOOGLE_CLIENT_ID) {
    (googleLoading || Promise.resolve()).then(() => {
      if (googleReady) window.google.accounts.id.renderButton(gbox, { type: 'standard', theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 280 });
    });
  }
  body.replaceChildren(
    h('h2', {}, guest ? 'Keep your reactions' : 'Join the conversation'),
    h('p', { class: 'muted' }, reason || (guest ? 'Create an account so your reactions and comments follow you.' : 'Sign in to react and comment.')),
    CONFIG.GOOGLE_CLIENT_ID ? gbox : null,
    CONFIG.GOOGLE_CLIENT_ID && inAppBrowser() ? h('p', { class: 'muted small' }, 'Google sign-in can fail inside other apps. If it does, open this page in your browser, or use email below.') : null,
    h('div', { class: 'or' }, 'or use email'),
    email, pw,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: run(async () => { if (!email.value || !pw.value) throw new Error('Enter your email and password.'); await emailSignIn(email.value.trim(), pw.value); closeSheet(); toast('Signed in.'); }) }, 'Sign in'),
      h('button', { class: 'btn', onclick: run(async () => { if (!email.value) throw new Error('Enter your email.'); say(await emailCreate(email.value.trim(), pw.value)); }) }, 'Create account')),
    h('button', { class: 'btn link', onclick: run(async () => { if (!email.value) throw new Error('Enter your email first.'); await resetPassword(email.value.trim()); say('If that email has an account, a reset link is on its way.'); }) }, 'Forgot password?'),
    msg,
    guest ? null : h('button', { class: 'btn', onclick: run(async () => { await continueAsGuest(); closeSheet(); toast('You are in as a guest.'); }) }, 'Continue as guest'),
    close);
}

// Resolves with the session once the visitor is in (guest or account), or null if they close the sheet.
export function requireAuth(reason) {
  if (session) return Promise.resolve(session);
  return new Promise((resolve) => {
    const off = onAuth((s) => { if (s) { off(); resolve(s); } });
    openSheet(reason).addEventListener('close', () => { off(); resolve(session); });
  });
}

/* ---------- header chip ---------- */
export function mountAccountChip(el) {
  const paint = () => { el.textContent = session ? displayName() : 'Sign in'; };
  el.addEventListener('click', () => openSheet());
  onAuth(paint);
  paint();
}
