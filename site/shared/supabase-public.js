// The public site's own Supabase client. It keeps viewer sessions separate from the owner's FabStudio session.
import { CONFIG } from './config.js';

export const sbp = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'fabrispoet-viewer-auth' },
});
