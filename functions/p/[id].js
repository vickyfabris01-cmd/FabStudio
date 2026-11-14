// Share links: https://YOUR-SITE/p/<poem id>
// Serves the poem page with a title, description and picture filled in, so links look right in WhatsApp,
// Facebook, X and search results. The page then loads the poem itself as usual.
import { CONFIG } from '../../site/shared/config.js';

const UUID = /^[0-9a-f-]{36}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function onRequestGet({ request, params, env }) {
  const url = new URL(request.url);
  const shell = await env.ASSETS.fetch(new URL('/poem/', url));
  let html = await shell.text();

  let item = null;
  const id = String(params.id || '');
  if (UUID.test(id)) {
    try {
      const r = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/items_public?id=eq.${id}&select=title,description,poem_stanzas,public_thumb_key&limit=1`,
        { headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` } },
      );
      if (r.ok) item = (await r.json())[0] || null;
    } catch { /* fall back to generic tags */ }
  }

  const title = item ? `${item.title} | Fabris Poet` : 'Fabris Poet';
  const firstStanza = Array.isArray(item?.poem_stanzas) ? String(item.poem_stanzas[0] || '').replace(/\s+/g, ' ').slice(0, 160) : '';
  const description = item ? (item.description || firstStanza || 'A poem, read aloud.') : 'Poems, read aloud.';
  const image = item?.public_thumb_key ? `${CONFIG.API_BASE}/public/${item.public_thumb_key}` : '';
  const page = `${url.origin}/p/${id}`;
  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Fabris Poet">`,
    `<meta property="og:title" content="${esc(item ? item.title : 'Fabris Poet')}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(page)}">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<link rel="canonical" href="${esc(page)}">`,
  ].filter(Boolean).join('\n  ');

  html = html.replace('<title>Fabris Poet</title>', '').replace('<!--OG-->', tags);
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}
