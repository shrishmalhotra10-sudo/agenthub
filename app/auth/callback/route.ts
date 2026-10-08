import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/** The email confirmation link lands here; we swap its one-time code for a session. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/chat`);
  }
  return NextResponse.redirect(`${origin}/login`);
}
