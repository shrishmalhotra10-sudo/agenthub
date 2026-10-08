'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getUser } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptSecret } from '@/lib/crypto';
import { checkEndpoint } from '@/lib/agents/external';
import { CATEGORIES } from '@/lib/chat/types';
import { SHAREABLE_FIELDS } from '@/lib/taskstate/schema';

const formSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1, 'Name is required').max(60),
    slug: z.string().trim().regex(/^[a-z0-9-]{3,48}$/, 'Web address: 3–48 lowercase letters, numbers or dashes'),
    description: z.string().trim().max(500),
    category: z.enum(CATEGORIES),
    kind: z.enum(['nocode', 'external']),
    provider: z.enum(['openai', 'anthropic', 'google']).optional(),
    model: z.string().trim().max(80).optional(),
    system_prompt: z.string().max(20_000).optional(),
    api_key: z.string().trim().max(500).optional(),
    endpoint_url: z.string().trim().max(500).optional(),
    needs: z.array(z.enum(SHAREABLE_FIELDS)),
    is_published: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'nocode' && (!v.provider || !v.model)) ctx.addIssue({ code: 'custom', message: 'Pick a provider and model.' });
    if (v.kind === 'external' && !v.endpoint_url) ctx.addIssue({ code: 'custom', message: 'Enter your endpoint URL.' });
  });

export type SaveState = { error?: string };

export async function saveAgent(_prev: SaveState, formData: FormData): Promise<SaveState> {
  const { supabase, user } = await getUser();
  if (!user) redirect('/login');

  const parsed = formSchema.safeParse({
    id: formData.get('id') || undefined,
    name: formData.get('name'),
    slug: formData.get('slug'),
    description: formData.get('description') ?? '',
    category: formData.get('category'),
    kind: formData.get('kind'),
    provider: formData.get('provider') || undefined,
    model: formData.get('model') || undefined,
    system_prompt: formData.get('system_prompt') ?? '',
    api_key: formData.get('api_key') || undefined,
    endpoint_url: formData.get('endpoint_url') || undefined,
    needs: formData.getAll('needs'),
    is_published: formData.get('is_published') === 'on',
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  const v = parsed.data;

  if (v.kind === 'external') {
    const problem = await checkEndpoint(v.endpoint_url!);
    if (problem) return { error: problem };
  }

  const row = {
    name: v.name,
    slug: v.slug,
    description: v.description,
    category: v.category,
    kind: v.kind,
    provider: v.kind === 'nocode' ? v.provider : null,
    model: v.kind === 'nocode' ? v.model : null,
    manifest: { needs: v.needs },
    is_published: v.is_published,
    updated_at: new Date().toISOString(),
  };

  if (!v.id) {
    const { count } = await supabase.from('agents').select('id', { count: 'exact', head: true }).eq('creator_id', user.id);
    if ((count ?? 0) >= 20) return { error: 'You can have up to 20 agents for now.' };
  }

  // RLS: creators can only insert/update agents where creator_id is themselves.
  const result = v.id
    ? await supabase.from('agents').update(row).eq('id', v.id).eq('creator_id', user.id).select('id').maybeSingle()
    : await supabase.from('agents').insert({ ...row, creator_id: user.id }).select('id').single();
  if (result.error?.code === '23505') return { error: 'That web address is taken. Try another.' };
  if (result.error || !result.data) return { error: 'Could not save the agent.' };
  const agentId = result.data.id;

  const { error: configError } = await supabase.from('agent_configs').upsert({
    agent_id: agentId,
    system_prompt: v.kind === 'nocode' ? v.system_prompt ?? '' : '',
    endpoint_url: v.kind === 'external' ? v.endpoint_url : null,
    updated_at: new Date().toISOString(),
  });
  if (configError) return { error: 'Saved the agent, but not its settings. Please try again.' };

  // The creator's API key: encrypted, stored where no browser can read it. Blank = keep existing.
  if (v.kind === 'nocode' && v.api_key) {
    try {
      const { error } = await createAdminClient()
        .from('agent_secrets')
        .upsert({ agent_id: agentId, api_key_encrypted: encryptSecret(v.api_key), updated_at: new Date().toISOString() });
      if (error) return { error: 'Saved the agent, but not the API key.' };
    } catch {
      return { error: 'Server setup incomplete (secret or encryption key missing), so the API key was not saved.' };
    }
  }

  revalidatePath('/creator');
  revalidatePath('/marketplace');
  redirect('/creator');
}

export async function deleteAgent(id: string) {
  if (!z.uuid().safeParse(id).success) return;
  const { supabase, user } = await getUser();
  if (!user) redirect('/login');
  await supabase.from('agents').delete().eq('id', id).eq('creator_id', user.id);
  revalidatePath('/creator');
  revalidatePath('/marketplace');
  redirect('/creator');
}
