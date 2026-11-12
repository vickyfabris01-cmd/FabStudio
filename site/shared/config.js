// ACTION: paste your own values here (docs/CONNECTIONS.md sections 1.3 and 2.4).
// None of these are secrets. Never paste a Supabase "service_role" or "secret" key into this file.
export const CONFIG = {
  // Supabase > Project Settings > API > Project URL
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  // Supabase > Project Settings > API > anon (legacy) or publishable key
  SUPABASE_ANON_KEY: 'YOUR-ANON-OR-PUBLISHABLE-KEY',
  // URL printed by `npx wrangler deploy` for the fabstudio-api Worker (no trailing slash)
  API_BASE: 'https://fabstudio-api.YOUR-SUBDOMAIN.workers.dev',
  // Phase 2 only (Google sign-in for viewers). Leave empty for now.
  GOOGLE_CLIENT_ID: '',
};
