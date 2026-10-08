import { notFound } from 'next/navigation';
import { z } from 'zod';
import { getUser } from '@/lib/supabase/server';
import { loadMessages, loadPanelData, loadPublicAgents } from '@/lib/chat/store';
import { ChatView } from '@/components/ChatView';

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const { supabase } = await getUser();
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, title, active_agent_id')
    .eq('id', id)
    .maybeSingle();
  if (!conversation) notFound();

  const [messages, agents, panel] = await Promise.all([
    loadMessages(supabase, id),
    loadPublicAgents(supabase),
    loadPanelData(supabase, id),
  ]);

  return (
    <ChatView
      key={conversation.id}
      conversationId={conversation.id}
      title={conversation.title}
      initialMessages={messages}
      agents={agents}
      initialAgentId={conversation.active_agent_id ?? agents[0]?.id ?? null}
      panel={panel}
    />
  );
}
