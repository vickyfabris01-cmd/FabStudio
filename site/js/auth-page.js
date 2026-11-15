// The sign in page (/auth/) and the create account page (/auth/signup/). One script, switched by data-mode on <body>.
import { CONFIG } from '../shared/config.js';
import { initAuth, emailSignIn, emailCreate, resetPassword, renderGoogleButton } from './auth-ui.js';

const $ = (id) => document.getElementById(id);
const signup = document.body.dataset.mode === 'signup';

// Where to go afterwards. Only a path on this site is accepted.
function nextPath() {
  const n = new URLSearchParams(location.search).get('next') || '';
  return n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : '/';
}
const next = nextPath();
$('back').href = next;
$('switch').href = (signup ? '/auth/' : '/auth/signup/') + (next === '/' ? '' : '?next=' + encodeURIComponent(next));

function say(text, ok) {
  const m = $('msg');
  m.textContent = text || '';
  m.className = ok ? 'muted' : 'error';
}

function friendly(e) {
  const m = String(e?.message || e || '');
  if (/invalid login credentials/i.test(m)) return "That email and password don't match.";
  if (/email not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox for the link.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Try again in a little while.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection. Please try again.';
  return m || 'Something went wrong.';
}

async function main() {
  const s = await initAuth();
  if (s && !s.user.is_anonymous) { location.replace(next); return; }
  if (s?.user?.is_anonymous) $('guestnote').hidden = false;

  if (CONFIG.GOOGLE_CLIENT_ID) {
    $('alt').hidden = false;
    renderGoogleButton($('gbox'), () => location.assign(next), signup ? 'signup_with' : 'continue_with');
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim();
    const pw = $('password').value;
    say('');
    if (!email) return say('Enter your email.');
    if (!pw) return say(signup ? 'Choose a password.' : 'Enter your password.');
    if (signup) {
      if (pw.length < 8) return say('Use at least 8 characters for the password.');
      if (pw !== $('confirm').value) return say("The passwords don't match.");
    }
    const btn = $('go');
    btn.disabled = true;
    say('One moment…', true);
    try {
      if (signup) {
        const r = await emailCreate(email, pw, location.origin + next);
        if (r === 'done') { location.assign(next); return; }
        say('Check your email and tap the link to finish. Your activity as a guest will move to your account.', true);
        $('form').reset();
      } else {
        await emailSignIn(email, pw);
        location.assign(next);
        return;
      }
    } catch (err) {
      say(friendly(err));
    }
    btn.disabled = false;
  });

  const forgot = $('forgot');
  if (forgot) {
    forgot.addEventListener('click', async () => {
      const email = $('email').value.trim();
      if (!email) return say('Enter your email first.');
      try { await resetPassword(email); say('If that email has an account, a reset link is on its way.', true); }
      catch (err) { say(friendly(err)); }
    });
  }
}
main();
