import { redirect } from 'next/navigation';
import { getUser } from '@/lib/supabase/server';
import { AppNav } from '@/components/AppNav';
import { AgentForm } from '@/components/AgentForm';

export default async function NewAgentPage() {
  const { user } = await getUser();
  if (!user) redirect('/login');
  return (
    <div className="min-h-dvh bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <AppNav signedIn />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold">New agent</h1>
        <AgentForm
          initial={{
            name: '',
            slug: '',
            description: '',
            category: 'general',
            kind: 'nocode',
            provider: 'openai',
            model: '',
            system_prompt: '',
            endpoint_url: '',
            needs: ['goal', 'constraints', 'decisions', 'progress', 'artifacts'],
            is_published: false,
            hasApiKey: false,
          }}
        />
      </main>
    </div>
  );
}
