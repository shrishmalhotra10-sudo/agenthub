import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getUser } from '@/lib/supabase/server';
import { PROVIDER_LABEL } from '@/lib/chat/types';
import { FIELD_LABEL, manifestNeeds } from '@/lib/taskstate/schema';
import { startChatWith } from '@/app/chat/actions';
import { AppNav } from '@/components/AppNav';

export default async function AgentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) notFound();

  const { supabase, user } = await getUser();
  const { data: agent } = await supabase
    .from('agents')
    .select('id, name, description, category, kind, provider, model, manifest, creator_id, created_at')
    .eq('slug', slug)
    .maybeSingle();
  if (!agent) notFound();
  const needs = manifestNeeds(agent.manifest);

  return (
    <div className="min-h-dvh bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <AppNav signedIn={Boolean(user)} />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/marketplace" className="text-sm text-zinc-500 hover:underline">← Marketplace</Link>
        <h1 className="mt-3 text-3xl font-semibold">{agent.name}</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">{agent.description}</p>

        <dl className="mt-6 grid grid-cols-2 gap-4 rounded-xl border border-zinc-200 p-4 text-sm sm:grid-cols-4 dark:border-zinc-800">
          <div><dt className="text-zinc-500">Category</dt><dd className="font-medium">{agent.category}</dd></div>
          <div>
            <dt className="text-zinc-500">Runs on</dt>
            <dd className="font-medium">{agent.kind === 'external' ? "Creator's own server" : PROVIDER_LABEL[agent.provider ?? ''] ?? agent.provider}</dd>
          </div>
          {agent.model && <div><dt className="text-zinc-500">Model</dt><dd className="font-medium">{agent.model}</dd></div>}
          <div><dt className="text-zinc-500">Made by</dt><dd className="font-medium">{agent.creator_id ? 'Community creator' : 'AgentHub'}</dd></div>
        </dl>

        <section className="mt-6">
          <h2 className="font-medium">What it asks to see when you hand a task to it</h2>
          <p className="text-sm text-zinc-500">You choose what to share each time, and can revoke it.</p>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {needs.length ? needs.map((n) => <li key={n} className="rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-800">{FIELD_LABEL[n]}</li>) : <li className="text-zinc-500">Nothing — it only sees messages you send it.</li>}
          </ul>
        </section>

        <div className="mt-8">
          {user ? (
            <form action={startChatWith.bind(null, agent.id)}>
              <button className="rounded-lg bg-zinc-900 px-5 py-2.5 font-medium text-white dark:bg-white dark:text-zinc-900">
                Start a chat with {agent.name}
              </button>
            </form>
          ) : (
            <Link href="/login" className="rounded-lg bg-zinc-900 px-5 py-2.5 font-medium text-white dark:bg-white dark:text-zinc-900">
              Sign in to use this agent
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
