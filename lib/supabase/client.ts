import { createBrowserClient } from '@supabase/ssr';

/** Browser-side Supabase client. Uses only the publishable key; RLS protects all data. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
