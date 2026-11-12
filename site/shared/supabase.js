// One Supabase client for the whole site. The library is loaded by a classic <script>
// tag (shared/vendor/supabase.js) before any module runs, so it lives on window.supabase.
import { CONFIG } from './config.js';

export const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
