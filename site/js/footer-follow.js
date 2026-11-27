// "Follow Fabris": the row of channel links in the footer of the public pages.
//
// HOW TO USE: this is the one place to edit. Put your link between the quotes of each platform, for example
//     url: 'https://www.youtube.com/@yourchannel?sub_confirmation=1',
// A platform whose link is left empty ('') does not show on the site. When every link is empty the whole section
// stays hidden. Nothing is fetched: the list and the icons are right here in the code, so they appear at once,
// even on a slow network.
//
// YouTube tip: ending the link with ?sub_confirmation=1 makes YouTube ask the visitor to subscribe as soon as the
// channel opens, which is one tap to subscribe.
//
// To add another platform, copy one line and give it a new key, label, link and icon (a 24x24 line icon).

const CHANNELS = [
  { key: 'youtube',   label: 'YouTube',            url: 'https://www.youtube.com/@fabris_poet?sub_confirmation=1', icon: '<path d="M2 8a4 4 0 0 1 4 -4h12a4 4 0 0 1 4 4v8a4 4 0 0 1 -4 4h-12a4 4 0 0 1 -4 -4v-8z"/><path d="M10 9l5 3l-5 3z"/>' },

  { key: 'facebook',  label: 'Facebook',           url: '', icon: '<path d="M7 10v4h3v7h4v-7h3l1 -4h-4v-2a1 1 0 0 1 1 -1h3v-4h-3a5 5 0 0 0 -5 5v2h-3"/>' },
  { key: 'instagram', label: 'Instagram',          url: 'https://www.facebook.com/FabMediaTec', icon: '<path d="M4 8a4 4 0 0 1 4 -4h8a4 4 0 0 1 4 4v8a4 4 0 0 1 -4 4h-8a4 4 0 0 1 -4 -4z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M16.5 7.5v.01"/>' },
  { key: 'tiktok',    label: 'TikTok',             url: '', icon: '<path d="M21 7.917v4.034a9.948 9.948 0 0 1 -5 -1.951v4.5a6.5 6.5 0 1 1 -8 -6.326v4.326a2.5 2.5 0 1 0 4 2v-11.5h4.083a6.005 6.005 0 0 0 4.917 4.917z"/>' },
  { key: 'x',         label: 'X',                  url: '', icon: '<path d="M4 4l11.733 16h4.267l-11.733 -16z"/><path d="M4 20l6.768 -6.768m2.46 -2.46l6.772 -6.772"/>' },
  { key: 'whatsapp',  label: 'WhatsApp channel',   url: '', icon: '<path d="M3 21l1.65 -3.8a9 9 0 1 1 3.4 2.9l-5.05 .9"/><path d="M9 10a.5 .5 0 0 0 1 0v-1a.5 .5 0 0 0 -1 0v1a5 5 0 0 0 5 5h1a.5 .5 0 0 0 0 -1h-1a.5 .5 0 0 0 0 1"/>' },
];

const NS = 'http://www.w3.org/2000/svg';
const foot = document.querySelector('footer.foot');
const shown = CHANNELS.filter((c) => /^https?:\/\//i.test(String(c.url || '').trim()));   // only real links; an empty one stays hidden

if (foot && shown.length) {
  const box = document.createElement('nav');
  box.className = 'foot-follow';
  box.setAttribute('aria-label', 'Follow Fabris');
  const title = document.createElement('b');
  title.textContent = 'Follow Fabris';
  box.append(title);
  for (const c of shown) {
    const a = document.createElement('a');
    a.href = c.url.trim();
    a.target = '_blank';
    a.rel = 'noopener noreferrer me';
    a.title = c.label;
    a.setAttribute('aria-label', `${c.label} (opens in a new tab)`);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = c.icon;
    a.append(svg);
    box.append(a);
  }
  // above the "FabisPot / Rights and policies" line, and below the create-account and install blocks
  foot.insertBefore(box, foot.querySelector('span') || null);
}
