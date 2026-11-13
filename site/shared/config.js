// ACTION: paste your own values here (docs/CONNECTIONS.md sections 1.3 and 2.4).
// None of these are secrets. Never paste a Supabase "service_role" or "secret" key into this file.
export const CONFIG = {
  // Supabase > Project Settings > API > Project URL
  SUPABASE_URL: 'https://sylkgfkseqxppmxtxfvs.supabase.co',
  // Supabase > Project Settings > API > anon (legacy) or publishable key
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN5bGtnZmtzZXF4cHBteHR4ZnZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1Mzk4NzIsImV4cCI6MjExMDExNTg3Mn0.ksVzsa1qaTlSFo_iFy0z5QSot4i_-rnsqpa39p_IpLo',
  // URL printed by `npx wrangler deploy` for the fabstudio-api Worker (no trailing slash)
  API_BASE: 'https://fabstudio-api.YOUR-SUBDOMAIN.workers.dev',
  // Phase 2 only (Google sign-in for viewers). Leave empty for now.
  GOOGLE_CLIENT_ID: '',
};
