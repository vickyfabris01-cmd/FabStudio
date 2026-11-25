// Live settings: one list, used by the Worker (to validate and enforce), FabStudio (to draw the settings
// screen) and the public page (only the keys marked public). Plain JavaScript, no browser or Worker APIs.
//
// To add a setting: add one entry to FIELDS and give it a default. Studio draws it, the Worker validates it.
import { parseYouTubeId } from './youtube-id.js';

export const FIELDS = [
  // ---- what viewers see
  { key: 'showViewCount', group: 'What viewers see', type: 'bool', default: true, public: true, label: 'Show the view count' },
  { key: 'showWatching', group: 'What viewers see', type: 'bool', default: true, public: true, label: 'Show how many are watching now' },
  { key: 'showReactionCounts', group: 'What viewers see', type: 'bool', default: true, public: true, label: 'Show the Love count' },
  // ---- chat
  { key: 'chatEnabled', group: 'Chat', type: 'bool', default: true, public: true, label: 'Chat is on' },
  { key: 'slowSeconds', group: 'Chat', type: 'int', default: 0, min: 0, max: 120, unit: 'seconds', label: 'Slow mode', hint: '0 is off. Otherwise one message per person every this many seconds.' },
  { key: 'chatMaxLength', group: 'Chat', type: 'int', default: 200, min: 20, max: 300, unit: 'characters', label: 'Longest message' },
  { key: 'chatHistory', group: 'Chat', type: 'int', default: 50, min: 0, max: 200, unit: 'messages', label: 'Messages a new viewer sees on arrival' },
  // ---- reactions
  { key: 'reactionsEnabled', group: 'Reactions', type: 'bool', default: true, public: true, label: 'Love is on' },
  // ---- requests
  { key: 'requestsEnabled', group: 'Requests', type: 'bool', default: true, public: true, label: 'Viewers can request a poem' },
  { key: 'requestsVisible', group: 'Requests', type: 'bool', default: true, public: true, label: 'Everyone sees the request queue', hint: 'Off means each person sees only their own.' },
  { key: 'requestsPerViewer', group: 'Requests', type: 'int', default: 3, min: 1, max: 10, unit: 'open at a time', label: 'Limit per person' },
  // ---- audio
  { key: 'audioKbps', group: 'Audio', type: 'choice', default: 96, number: true, label: 'Quality sent to viewers',
    options: [[32, '32 kbps (smallest, voice only)'], [64, '64 kbps'], [96, '96 kbps (recommended for voice over music)'], [128, '128 kbps (best, most data)']],
    hint: 'Higher is clearer but uses more of every viewer\'s data, and more of your Cloudflare allowance.' },
  { key: 'stereo', group: 'Audio', type: 'bool', default: true, label: 'Send stereo' },
  // ---- countdown
  { key: 'countdownEnabled', group: 'Countdown', type: 'bool', default: true, public: true, label: 'Show a countdown before the start', hint: 'The countdown never starts the live. Only your Go live button does.' },
  { key: 'countdownMinutes', group: 'Countdown', type: 'int', default: 60, min: 5, max: 1440, unit: 'minutes before', public: true, label: 'Countdown begins' },
  // ---- YouTube video (optional). The audio live never depends on it.
  { key: 'ytVideoId', group: 'YouTube video', type: 'ytid', default: '', public: true, label: 'YouTube link or video ID', hint: 'Paste the link of your YouTube live. The Check YouTube live button on the ready card fills this in for you.' },
  { key: 'ytShow', group: 'YouTube video', type: 'bool', default: false, public: true, label: 'Viewers can watch the video', hint: 'Adds a Watch video button on the live page. Audio stays the default.' },
  // ---- host
  { key: 'hostName', group: 'Host', type: 'text', default: 'Fabris', max: 30, label: 'Name shown on your chat messages' },
];

export const DEFAULT_SETTINGS = Object.fromEntries(FIELDS.map((f) => [f.key, f.default]));

// Keeps only known keys and forces every value into its allowed range. Unknown or bad values fall back to `base`.
export function cleanSettings(input, base = DEFAULT_SETTINGS) {
  const out = { ...DEFAULT_SETTINGS, ...base };
  if (!input || typeof input !== 'object') return out;
  for (const f of FIELDS) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    if (f.type === 'bool') { if (typeof v === 'boolean') out[f.key] = v; }
    else if (f.type === 'int') {
      const n = Math.round(Number(v));
      if (Number.isFinite(n)) out[f.key] = Math.min(f.max, Math.max(f.min, n));
    } else if (f.type === 'choice') {
      const found = f.options.find(([val]) => String(val) === String(v));
      if (found) out[f.key] = found[0];
    } else if (f.type === 'ytid') {
      const id = parseYouTubeId(v);   // '' clears it, null means it was not a YouTube link (the old value stays)
      if (id !== null) out[f.key] = id;
    } else if (f.type === 'text') {
      const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, f.max);
      out[f.key] = s || f.default;
    }
  }
  return out;
}

// The part of the settings any visitor may know.
export function publicSettings(s) {
  const out = {};
  for (const f of FIELDS) if (f.public) out[f.key] = s[f.key];
  if (!out.ytShow) out.ytVideoId = '';   // an unlisted YouTube link stays private until the host shows it
  return out;
}