import { redirect } from 'next/navigation';
import { getUser } from '@/lib/supabase/server';
import { LoginForm } from '@/components/LoginForm';

export default async function LoginPage() {
  const { user } = await getUser();
  if (user) redirect('/marketplace');
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-50 p-4 dark:bg-zinc-950">
      <LoginForm />
    </main>
  );
}
