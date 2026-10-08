import 'server-only';
import { createClient } from '@supabase/supabase-js';

export class MissingSecretKeyError extends Error {
  constructor() {
    super('SUPABASE_SECRET_KEY is not set in .env.local');
  }
}

/**
 * Supabase client with the SECRET key. Bypasses RLS.
 * Only used to read agent configs (system prompts) that end users must never see.
 * Never import this from a client component — `server-only` makes the build fail if you do.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new MissingSecretKeyError();
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
