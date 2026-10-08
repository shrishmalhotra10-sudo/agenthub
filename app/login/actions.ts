'use server';

import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';

const schema = z.object({ email: z.email().max(200), password: z.string().min(8).max(200) });

/**
 * Local development only: create an account that's confirmed immediately,
 * so testing doesn't depend on Supabase's (slow, rate-limited) emails.
 * In production this returns { instant: false } and the normal email flow is used.
 */
export async function signUpInstant(email: string, password: string): Promise<{ instant: boolean; error?: string }> {
  if (process.env.NODE_ENV !== 'development') return { instant: false };
  const parsed = schema.safeParse({ email, password });
  if (!parsed.success) return { instant: true, error: 'Enter a valid email and a password of at least 8 characters.' };
  try {
    const { error } = await createAdminClient().auth.admin.createUser({
      email: parsed.data.email,
      password: parsed.data.password,
      email_confirm: true,
    });
    if (error) return { instant: true, error: error.message.includes('already') ? 'That email already has an account. Sign in instead.' : 'Could not create the account.' };
    return { instant: true };
  } catch {
    // Secret key not configured: fall back to the normal email flow.
    return { instant: false };
  }
}
