import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyPatch, describePatch, fieldsSchema, normalizeTaskState, type ShareableField, type TaskPatch, type TaskState } from './schema';

/** Loads the Task State for a conversation (creating an empty one if needed). RLS: owner only. */
export async function getTaskState(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<{ state: TaskState; version: number }> {
  const { data } = await supabase
    .from('task_states')
    .select('state, version')
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (data) return { state: normalizeTaskState(data.state), version: data.version };
  const empty = normalizeTaskState({});
  await supabase.from('task_states').insert({ conversation_id: conversationId, state: empty, version: 1 });
  return { state: empty, version: 1 };
}

/**
 * Saves a new state only if nobody else changed it in the meantime (version check).
 * Returns the new version, or null on conflict.
 */
export async function saveTaskState(
  supabase: SupabaseClient,
  conversationId: string,
  state: TaskState,
  expectedVersion: number,
): Promise<number | null> {
  const { data } = await supabase
    .from('task_states')
    .update({ state: normalizeTaskState(state), version: expectedVersion + 1, updated_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('version', expectedVersion)
    .select('version')
    .maybeSingle();
  return data?.version ?? null;
}

/** Applies a patch with a few retries on version conflicts, and records it in the history. */
export async function applyAndRecord(
  supabase: SupabaseClient,
  opts: {
    conversationId: string;
    userId: string;
    patch: Partial<TaskPatch>;
    by: string;
    source: 'extractor' | 'user' | 'agent';
    agentId?: string | null;
    /** Extra mutation after the patch (e.g. adding an artifact entry). */
    mutate?: (state: TaskState) => TaskState;
    /** Human summary for the history; defaults to a description of the patch. */
    summary?: string;
  },
): Promise<TaskState | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, version } = await getTaskState(supabase, opts.conversationId);
    let next = applyPatch(state, opts.patch, opts.by);
    if (opts.mutate) next = normalizeTaskState(opts.mutate(next));
    const saved = await saveTaskState(supabase, opts.conversationId, next, version);
    if (saved !== null) {
      await supabase.from('task_state_changes').insert({
        conversation_id: opts.conversationId,
        user_id: opts.userId,
        source: opts.source,
        agent_id: opts.agentId ?? null,
        summary: (opts.summary ?? describePatch(opts.patch)).slice(0, 300),
        patch: opts.patch,
        status: 'applied',
      });
      return next;
    }
  }
  return null;
}

const MAX_PENDING = 10;

/** Records a suggested change for the user to approve. Skipped if too many are already waiting. */
export async function insertPendingChange(
  supabase: SupabaseClient,
  opts: { conversationId: string; userId: string; agentId: string; source: 'extractor' | 'agent'; patch: Partial<TaskPatch> },
): Promise<boolean> {
  const { count } = await supabase
    .from('task_state_changes')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', opts.conversationId)
    .eq('status', 'pending');
  if ((count ?? 0) >= MAX_PENDING) return false;
  const { error } = await supabase.from('task_state_changes').insert({
    conversation_id: opts.conversationId,
    user_id: opts.userId,
    source: opts.source,
    agent_id: opts.agentId,
    summary: describePatch(opts.patch).slice(0, 300),
    patch: opts.patch,
    status: 'pending',
  });
  return !error;
}

/** The fields the user currently lets this agent see in this conversation (empty = nothing). */
export async function getConsentedFields(
  supabase: SupabaseClient,
  conversationId: string,
  agentId: string,
): Promise<ShareableField[]> {
  const { data } = await supabase
    .from('consents')
    .select('fields, revoked_at')
    .eq('conversation_id', conversationId)
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data || data.revoked_at) return [];
  const parsed = fieldsSchema.safeParse(data.fields);
  return parsed.success ? parsed.data : [];
}
