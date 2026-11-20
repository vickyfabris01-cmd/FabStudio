// Makes the public site installable: registers its service worker and keeps the browser's install offer
// until the footer button asks for it. Android and desktop Chrome/Edge offer a real install prompt.
// iPhones and iPads have none, so the footer shows the "Add to Home Screen" steps instead.
let deferred = null;
let installed = false;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } });

const standalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const onIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const inAppBrowser = () => /; wv\)|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('Service worker failed', e));
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
window.addEventListener('appinstalled', () => { deferred = null; installed = true; notify(); });

// 'prompt' (a real install prompt is ready), 'ios' (show the steps), or null (nothing to offer).
export function installMode() {
  if (installed || standalone()) return null;
  if (deferred) return 'prompt';
  if (onIOS() && !inAppBrowser()) return 'ios';
  return null;
}
export async function promptInstall() {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  e.prompt();
  let ok = false;
  try { ok = (await e.userChoice).outcome === 'accepted'; } catch { /* closed */ }
  notify();
  return ok;
}
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
