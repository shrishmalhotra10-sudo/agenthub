import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isProviderLive } from '@/lib/agents/providers';
import { createAdminClient } from '@/lib/supabase/admin';
import { FIELD_LABEL, fieldsSchema, manifestNeeds } from '@/lib/taskstate/schema';
import { getTaskState } from '@/lib/taskstate/store';
import type { PanelData } from '@/components/TaskPanel';
import type { AppUIMessage, PublicAgent } from './types';

type MessageRow = {
  id: string;
  role: 'user' | 'assistant';
  agent_id: string | null;
  parts: AppUIMessage['parts'];
};

/** Loads the most recent `limit` messages of a conversation, oldest first. */
export async function loadMessages(
  supabase: SupabaseClient,
  conversationId: string,
  limit = 200,
): Promise<AppUIMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, role, agent_id, parts')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as MessageRow[]).reverse().map((row) => ({
    id: row.id,
    role: row.role,
    parts: row.parts,
    metadata: row.agent_id ? { agentId: row.agent_id } : undefined,
  }));
}

/** Published agents (plus the user's own), with only browser-safe fields. */
export async function loadPublicAgents(supabase: SupabaseClient): Promise<PublicAgent[]> {
  const { data, error } = await supabase
    .from('agents')
    .select('id, name, description, category, kind, provider, model, manifest, creator_id')
    .order('created_at', { ascending: true });
  if (error) throw error;
  const agents = data ?? [];

  // Creator agents are "live" when the creator saved an API key (checked server-side only).
  const creatorAgentIds = agents.filter((a) => a.creator_id && a.kind === 'nocode').map((a) => a.id);
  let withKey = new Set<string>();
  if (creatorAgentIds.length) {
    try {
      const { data: secrets } = await createAdminClient().from('agent_secrets').select('agent_id').in('agent_id', creatorAgentIds);
      withKey = new Set((secrets ?? []).map((s) => s.agent_id));
    } catch {
      // No secret key configured yet: treat creator agents as demo.
    }
  }

  return agents.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    category: a.category,
    kind: a.kind,
    provider: a.provider,
    model: a.model,
    needs: manifestNeeds(a.manifest),
    byCreator: Boolean(a.creator_id),
    live: a.kind === 'external' ? true : a.creator_id ? withKey.has(a.id) : isProviderLive(a.provider),
  }));
}

/** Everything the Task State side panel shows. RLS: owner only. */
export async function loadPanelData(supabase: SupabaseClient, conversationId: string): Promise<PanelData> {
  const [{ state, version }, changes, consents, shares, agents] = await Promise.all([
    getTaskState(supabase, conversationId),
    supabase
      .from('task_state_changes')
      .select('id, source, agent_id, summary, patch, status, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('consents')
      .select('id, agent_id, fields, revoked_at, created_at')
      .eq('conversation_id', conversationId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false }),
    supabase
      .from('share_log')
      .select('id, agent_id, fields, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(15),
    supabase.from('agents').select('id, name'),
  ]);
  const nameOf = (id: string | null) => (id && agents.data?.find((a) => a.id === id)?.name) || 'An agent';

  const pending = (changes.data ?? [])
    .filter((c) => c.status === 'pending')
    .map((c) => ({ id: c.id, summary: c.summary, agentName: nameOf(c.agent_id), patch: c.patch ?? {} }));

  const activity = [
    ...(changes.data ?? [])
      .filter((c) => c.status !== 'pending')
      .map((c) => ({
        key: `c${c.id}`,
        at: c.created_at,
        text:
          c.source === 'user'
            ? c.summary.startsWith('You ') ? c.summary : `You set the ${c.summary}`
            : c.source === 'extractor' && c.status === 'applied' && !(c.patch as { add_decisions?: unknown[] } | null)?.add_decisions?.length
              ? `Brief updated after ${nameOf(c.agent_id)}: ${c.summary}`
              : `You ${c.status === 'applied' ? 'approved' : 'rejected'} ${nameOf(c.agent_id)}'s suggestion: ${c.summary}`,
      })),
    ...(shares.data ?? []).map((s) => ({
      key: `s${s.id}`,
      at: s.created_at,
      text: `Shared with ${nameOf(s.agent_id)}: ${(fieldsSchema.safeParse(s.fields).data ?? []).map((f) => FIELD_LABEL[f]).join(', ')}`,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);

  // Only the newest consent per agent counts.
  const seen = new Set<string>();
  const activeConsents = (consents.data ?? []).filter((c) => !seen.has(c.agent_id) && seen.add(c.agent_id));

  return {
    state,
    version,
    pending,
    consents: activeConsents.map((c) => ({ id: c.id, agentName: nameOf(c.agent_id), fields: fieldsSchema.safeParse(c.fields).data ?? [] })),
    activity,
  };
}
