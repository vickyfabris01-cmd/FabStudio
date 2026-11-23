// A WebSocket to the live room (the LiveRoom Durable Object), shared by FabStudio and the public page.
// It signs in with the first message (hello), reconnects by itself, and sends a keep-alive.
import { CONFIG } from './config.js';

export const roomUrl = (item) => `${CONFIG.API_BASE.replace(/^http/, 'ws')}/live/ws?item=${encodeURIComponent(item)}`;

// onStatus gets 'connecting' | 'open' | 'reconnecting' | 'closed'. onMessage gets each parsed message.
// Pass console: true from FabStudio so the room knows this is the host's console.
// Pass ref (from an invite link) on the public page so the room can tell the host who invited this person.
export function connectRoom({ item, getToken, console: asConsole = false, ref = '', onMessage, onStatus = () => {} }) {
  let ws = null;
  let closed = false;
  let tries = 0;
  let retry = null;
  let beat = null;

  let opening = false;
  const hello = async () => {
    const token = await getToken();
    if (token && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'hello', token, console: asConsole, ...(ref ? { ref } : {}) }));
    // Someone who was waiting to sign in has just signed in: connect now instead of at the next retry.
    else if (token && !ws && !opening && !closed) { clearTimeout(retry); open(); }
  };

  const later = () => {
    if (closed) return;
    tries += 1;
    onStatus('reconnecting');
    clearTimeout(retry);
    retry = setTimeout(open, Math.min(15000, 400 * 2 ** Math.min(tries, 6)) + Math.random() * 400);
  };

  async function open() {
    if (closed || opening) return;
    opening = true;
    onStatus(tries ? 'reconnecting' : 'connecting');
    const token = await getToken();
    opening = false;
    if (closed) return;
    if (!token) return later(); // not signed in yet: keep checking, and hello() connects at once after sign-in
    try { ws = new WebSocket(roomUrl(item)); } catch { return later(); }
    const mine = ws;
    mine.onopen = () => {
      tries = 0;
      mine.send(JSON.stringify({ t: 'hello', token, console: asConsole, ...(ref ? { ref } : {}) }));
      onStatus('open');
      clearInterval(beat);
      beat = setInterval(() => { if (mine.readyState === 1) mine.send('{"t":"ping"}'); }, 25000);
    };
    mine.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore a bad message */ } };
    mine.onclose = () => { clearInterval(beat); if (ws === mine) ws = null; later(); };
    mine.onerror = () => { /* onclose follows */ };
  }
  open();

  return {
    send(obj) {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(obj));
      return true;
    },
    hello, // call again after the person signs in or out, so the room learns who they are now
    close() {
      closed = true;
      clearTimeout(retry);
      clearInterval(beat);
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      onStatus('closed');
    },
  };
}
