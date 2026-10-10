'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getUser } from '@/lib/supabase/server';

export async function createConversation() {
  const { supabase, user } = await getUser();
  if (!user) redirect('/login');
  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: user.id })
    .select('id')
    .single();
  if (error || !data) throw new Error('Could not start a new chat.');
  redirect(`/chat/${data.id}`);
}

export async function deleteConversation(id: string) {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return;
  const { supabase, user } = await getUser();
  if (!user) redirect('/login');
  // RLS makes this a no-op for anyone else's conversation.
  // Remove the chat's uploaded files from storage too (their DB rows go with the chat via cascade).
  const { data: files } = await supabase.from('files').select('storage_path').eq('conversation_id', parsed.data);
  if (files?.length) await supabase.storage.from('uploads').remove(files.map((f) => f.storage_path));
  await supabase.from('conversations').delete().eq('id', parsed.data);
  revalidatePath('/chat', 'layout');
  redirect('/chat');
}

export async function signOut() {
  const { supabase } = await getUser();
  await supabase.auth.signOut();
  redirect('/login');
}

/** "Start chat" on a marketplace agent page: new conversation with that agent selected. */
export async function startChatWith(agentId: string) {
  const parsed = z.uuid().safeParse(agentId);
  if (!parsed.success) return;
  const { supabase, user } = await getUser();
  if (!user) redirect('/login');
  const { data: agent } = await supabase.from('agents').select('id').eq('id', parsed.data).maybeSingle();
  if (!agent) redirect('/marketplace');
  const { data, error } = await supabase
    .from('conversations')
    .insert({ user_id: user.id, active_agent_id: agent.id })
    .select('id')
    .single();
  if (error || !data) throw new Error('Could not start a new chat.');
  redirect(`/chat/${data.id}`);
}
