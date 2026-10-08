'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getUser } from '@/lib/supabase/server';
import { renderBrief } from '@/lib/taskstate/render';
import { applyPatch, fieldsSchema, normalizeTaskState, taskPatchSchema, taskStateSchema, type ShareableField } from '@/lib/taskstate/schema';
import { applyAndRecord, getTaskState, saveTaskState } from '@/lib/taskstate/store';

const uuid = z.uuid();

async function requireOwnConversation(conversationId: string) {
  if (!uuid.safeParse(conversationId).success) throw new Error('Invalid conversation.');
  const { supabase, user } = await getUser();
  if (!user) throw new Error('Please sign in again.');
  const { data } = await supabase.from('conversations').select('id').eq('id', conversationId).maybeSingle();
  if (!data) throw new Error('Conversation not found.');
  return { supabase, user };
}

/** The user edits the brief directly in the side panel. */
export async function saveTaskStateAction(conversationId: string, rawState: unknown, expectedVersion: number) {
  const { supabase, user } = await requireOwnConversation(conversationId);
  const parsed = taskStateSchema.safeParse(rawState);
  if (!parsed.success) return { ok: false as const, error: 'Some fields are too long or invalid.' };
  const saved = await saveTaskState(supabase, conversationId, parsed.data, expectedVersion);
  if (saved === null) return { ok: false as const, error: 'The brief changed while you were editing. Reload and try again.' };
  await supabase.from('task_state_changes').insert({
    conversation_id: conversationId,
    user_id: user.id,
    source: 'user',
    summary: 'You edited the brief',
    patch: {},
    status: 'applied',
  });
  revalidatePath(`/chat/${conversationId}`);
  return { ok: true as const, version: saved };
}

/** Shows exactly what the next agent will receive, before the user agrees to share it. */
export async function previewHandoff(conversationId: string, agentId: string, rawFields: string[]) {
  const { supabase } = await requireOwnConversation(conversationId);
  const fields = fieldsSchema.parse(rawFields) as ShareableField[];
  const { state } = await getTaskState(supabase, conversationId);
  const { data: last } = await supabase
    .from('messages')
    .select('agent_id')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let previousAgentName: string | null = null;
  if (last?.agent_id && last.agent_id !== agentId) {
    const { data } = await supabase.from('agents').select('name').eq('id', last.agent_id).maybeSingle();
    previousAgentName = data?.name ?? 'another agent';
  }
  if (!fields.length) return 'Nothing will be shared. The agent will only see the messages you send it from now on.';
  return renderBrief({
    state,
    fields,
    previousAgentName,
    earlierTranscript: fields.includes('chat_history') ? '(the earlier messages in this chat)' : undefined,
  });
}

/** User confirms the handoff: records consent for exactly these fields and sets the next step. */
export async function confirmHandoff(conversationId: string, agentId: string, rawFields: string[], nextStep: string) {
  const { supabase, user } = await requireOwnConversation(conversationId);
  if (!uuid.safeParse(agentId).success) throw new Error('Invalid agent.');
  const fields = fieldsSchema.parse(rawFields);
  const { data: agent } = await supabase.from('agents').select('id').eq('id', agentId).maybeSingle();
  if (!agent) throw new Error('Agent not found.');

  // Close any earlier consent for this agent, then record the new one.
  await supabase
    .from('consents')
    .update({ revoked_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('agent_id', agentId)
    .is('revoked_at', null);
  const { error } = await supabase.from('consents').insert({ conversation_id: conversationId, user_id: user.id, agent_id: agentId, fields });
  if (error) throw new Error('Could not save your sharing choice.');

  const step = nextStep.trim().slice(0, 500);
  if (step) {
    await applyAndRecord(supabase, { conversationId, userId: user.id, patch: { next_step: step }, by: 'user', source: 'user' });
  }
  await supabase.from('conversations').update({ active_agent_id: agentId }).eq('id', conversationId);
  revalidatePath(`/chat/${conversationId}`);
  return { ok: true as const };
}

export async function revokeConsent(conversationId: string, consentId: string) {
  const { supabase } = await requireOwnConversation(conversationId);
  if (!uuid.safeParse(consentId).success) return;
  await supabase
    .from('consents')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', consentId)
    .eq('conversation_id', conversationId);
  revalidatePath(`/chat/${conversationId}`);
}

/** Approve or reject an agent's proposed change to the brief. */
export async function decideChange(conversationId: string, changeId: number, approve: boolean) {
  const { supabase } = await requireOwnConversation(conversationId);
  const { data: change } = await supabase
    .from('task_state_changes')
    .select('id, patch, status, agent_id')
    .eq('id', changeId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (!change || change.status !== 'pending') return;

  // Claim it atomically, so a double-click can't apply it twice.
  const { data: claimed } = await supabase
    .from('task_state_changes')
    .update({ status: approve ? 'applied' : 'rejected' })
    .eq('id', change.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (!claimed) return;

  if (approve) {
    const patch = taskPatchSchema.partial().safeParse(change.patch);
    let saved: number | null = null;
    if (patch.success) {
      let by = 'agent';
      if (change.agent_id) {
        const { data } = await supabase.from('agents').select('name').eq('id', change.agent_id).maybeSingle();
        by = data?.name ?? by;
      }
      for (let attempt = 0; attempt < 3 && saved === null; attempt++) {
        const { state, version } = await getTaskState(supabase, conversationId);
        saved = await saveTaskState(supabase, conversationId, normalizeTaskState(applyPatch(state, patch.data, by)), version);
      }
    }
    if (saved === null) {
      await supabase.from('task_state_changes').update({ status: 'pending' }).eq('id', change.id);
      throw new Error('Could not apply that change. Please try again.');
    }
  }
  revalidatePath(`/chat/${conversationId}`);
}

export async function getArtifactContent(conversationId: string, artifactId: string) {
  const { supabase } = await requireOwnConversation(conversationId);
  if (!uuid.safeParse(artifactId).success) return null;
  const { data } = await supabase
    .from('artifacts')
    .select('title, version, content')
    .eq('id', artifactId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  return data;
}
