// Owner sign-in. After the first successful sign-in the app opens without a network.
import { sb } from '../../shared/supabase.js';
import { db } from './db.js';

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const { data: isOwner, error: e2 } = await sb.rpc('is_owner');
  if (e2) throw e2;
  if (!isOwner) {
    await sb.auth.signOut();
    throw new Error('This account is not the FabStudio owner. Check step 1.5 in docs/CONNECTIONS.md.');
  }
  await db.meta.put({ key: 'owner', value: { id: data.user.id, email: data.user.email } });
  return data.user;
}

export async function signOut() {
  await sb.auth.signOut();
  await db.meta.delete('owner'); // local poems stay on the device
}

export async function ownerInfo() {
  return (await db.meta.get('owner'))?.value || null;
}

// Returns an access token, or null when signed out / offline with an expired session.
export async function getToken() {
  try {
    const { data } = await sb.auth.getSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}
