import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { getUser } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { signingSecretFor } from '@/lib/crypto';
import { manifestNeeds } from '@/lib/taskstate/schema';
import { AppNav } from '@/components/AppNav';
import { AgentForm } from '@/components/AgentForm';
import { SubmitButton } from '@/components/SubmitButton';
import { deleteAgent } from '../actions';

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, user } = await getUser();
  if (!user) redirect('/login');

  // RLS + explicit check: only the creator can open their agent's settings.
  const { data: agent } = await supabase
    .from('agents')
    .select('id, slug, name, description, category, kind, provider, model, manifest, is_published')
    .eq('id', id)
    .eq('creator_id', user.id)
    .maybeSingle();
  if (!agent) notFound();
  const { data: config } = await supabase.from('agent_configs').select('system_prompt, endpoint_url').eq('agent_id', id).maybeSingle();

  let hasApiKey = false;
  let signingSecret: string | null = null;
  try {
    const { data } = await createAdminClient().from('agent_secrets').select('agent_id').eq('agent_id', id).maybeSingle();
    hasApiKey = Boolean(data);
    if (agent.kind === 'external') signingSecret = signingSecretFor(agent.id);
  } catch {
    // Secret/encryption keys not configured yet.
  }

  return (
    <div className="min-h-dvh bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <AppNav signedIn />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-semibold">Edit {agent.name}</h1>

        {signingSecret && (
          <div className="mb-6 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
            <p className="font-medium">Your signing secret</p>
            <p className="text-xs text-zinc-500">
              Use it on your server to check that requests really come from AgentHub (header <code>x-agenthub-signature</code> = HMAC-SHA256 of
              <code> timestamp.body</code>). Keep it private.
            </p>
            <code className="mt-2 block break-all rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{signingSecret}</code>
          </div>
        )}

        <AgentForm
          initial={{
            id: agent.id,
            name: agent.name,
            slug: agent.slug,
            description: agent.description,
            category: agent.category,
            kind: agent.kind,
            provider: agent.provider ?? 'openai',
            model: agent.model ?? '',
            system_prompt: config?.system_prompt ?? '',
            endpoint_url: config?.endpoint_url ?? '',
            needs: manifestNeeds(agent.manifest),
            is_published: agent.is_published,
            hasApiKey,
          }}
        />

        <form action={deleteAgent.bind(null, agent.id)} className="mt-10 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          <SubmitButton
            pendingText="Deleting…"
            confirmText="Delete this agent? It disappears from the marketplace and from users' agent pickers."
            className="text-sm text-red-600 hover:underline"
          >
            Delete this agent
          </SubmitButton>
        </form>
      </main>
    </div>
  );
}
