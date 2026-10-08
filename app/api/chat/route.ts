import {
  APICallError,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  tool,
  toUIMessageStream,
  type ModelMessage,
} from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getUser } from '@/lib/supabase/server';
import { createAdminClient, MissingSecretKeyError } from '@/lib/supabase/admin';
import { createDemoModel, getModel } from '@/lib/agents/providers';
import { buildInstructions } from '@/lib/agents/prompt';
import { callExternalAgent, type ExternalRequest } from '@/lib/agents/external';
import { decryptSecret, opaqueTaskId } from '@/lib/crypto';
import { prepareForModel } from '@/lib/files/resolve';
import { loadMessages } from '@/lib/chat/store';
import { consumeQuota } from '@/lib/ratelimit';
import { FILE_URL_RE, fileIdFromUrl, PROVIDER_LABEL, type AppUIMessage } from '@/lib/chat/types';
import { briefForExternal, clean, fenceData, renderBrief } from '@/lib/taskstate/render';
import { taskPatchSchema, type ShareableField, type TaskState } from '@/lib/taskstate/schema';
import { getConsentedFields, getTaskState, insertPendingChange } from '@/lib/taskstate/store';
import { updateTaskStateAfterTurn } from '@/lib/taskstate/extract';

export const runtime = 'nodejs';
export const maxDuration = 90;

const HISTORY_FOR_MODEL = 40;

// The browser sends ONLY the new user message. History is loaded from the
// database, so a tampered client can't rewrite what earlier agents said.
const bodySchema = z.object({
  conversationId: z.uuid(),
  agentId: z.uuid(),
  message: z.object({
    id: z.string().min(1).max(64),
    role: z.literal('user'),
    parts: z
      .array(
        z.union([
          z.object({ type: z.literal('text'), text: z.string().max(20_000) }),
          // Only our own /api/files/<id> URLs are accepted — never arbitrary URLs.
          z.object({ type: z.literal('file'), url: z.string().regex(FILE_URL_RE) }).loose(),
        ]),
      )
      .min(1)
      .max(12),
  }),
});

const text = (message: string, status: number) => new Response(message, { status });
const textOf = (m: AppUIMessage) =>
  m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'file' ? `[file: ${p.filename ?? 'file'}]` : '')).join('\n').trim();

export async function POST(req: Request) {
  const { supabase, user } = await getUser();
  if (!user) return text('Please sign in again.', 401);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return text('That message could not be sent (invalid format).', 400);
  const { conversationId, agentId, message } = parsed.data;

  // RLS: these only return rows the user is allowed to see.
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, title')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversation) return text('Conversation not found.', 404);

  const { data: agent } = await supabase
    .from('agents')
    .select('id, name, kind, provider, model, creator_id')
    .eq('id', agentId)
    .maybeSingle();
  if (!agent) return text('That agent is not available.', 404);

  // ── Rebuild the user's message from trusted data only ──
  const textParts = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => ({ type: 'text' as const, text: (p as { text: string }).text.trim() }))
    .filter((p) => p.text);
  const fileIds = [...new Set(message.parts.flatMap((p) => (p.type === 'file' ? [fileIdFromUrl(p.url)!] : [])))];
  let fileParts: AppUIMessage['parts'] = [];
  if (fileIds.length) {
    const { data: files } = await supabase
      .from('files')
      .select('id, name, media_type, conversation_id')
      .in('id', fileIds);
    const usable = (files ?? []).filter((f) => f.conversation_id === null || f.conversation_id === conversationId);
    if (usable.length !== fileIds.length) return text('One of the attached files was not found.', 400);
    fileParts = usable.map((f) => ({ type: 'file' as const, mediaType: f.media_type, filename: f.name, url: `/api/files/${f.id}` }));
  }
  if (!textParts.length && !fileParts.length) return text('Message is empty.', 400);

  // The secret-key client reads hidden agent configs/keys and saves agent replies + share logs.
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (err) {
    if (err instanceof MissingSecretKeyError) {
      return text('Server setup incomplete: add SUPABASE_SECRET_KEY to .env.local and restart.', 500);
    }
    throw err;
  }

  const limited = await consumeQuota(supabase, 'chat', agent.id);
  if (limited) return text(limited, 429);

  const { error: insertError } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    id: message.id,
    user_id: user.id,
    role: 'user',
    parts: [...fileParts, ...textParts],
  });
  // 23505 = this message id was already sent. Refuse, so a resend can't trigger free model calls.
  if (insertError?.code === '23505') return text('That message was already sent.', 409);
  if (insertError) return text('Could not save your message.', 500);

  const userText = textParts.map((p) => p.text).join('\n');
  const firstText = userText || (fileParts[0] as { filename?: string })?.filename || '';
  await supabase
    .from('conversations')
    .update({
      active_agent_id: agent.id,
      updated_at: new Date().toISOString(),
      ...(conversation.title === 'New chat' && firstText ? { title: firstText.slice(0, 60) } : {}),
    })
    .eq('id', conversationId);

  const { data: config } = await admin
    .from('agent_configs')
    .select('system_prompt, endpoint_url')
    .eq('agent_id', agent.id)
    .maybeSingle();

  // ── Which part of the conversation belongs to this agent ──
  // An agent sees the messages since it took over. Everything before that reaches
  // it only through the Task State brief — and only the fields the user consented to.
  const history = await loadMessages(supabase, conversationId, HISTORY_FOR_MODEL);
  let cut = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.metadata?.agentId && m.metadata.agentId !== agent.id) {
      cut = i;
      break;
    }
  }
  const segment = history.slice(cut + 1);
  const previousAgentId = cut >= 0 ? history[cut].metadata?.agentId ?? null : null;
  const isHandoffTurn = previousAgentId !== null && !segment.some((m) => m.role === 'assistant');

  let previousAgentName: string | null = null;
  if (previousAgentId) {
    const { data } = await admin.from('agents').select('name').eq('id', previousAgentId).maybeSingle();
    previousAgentName = data?.name ?? 'another agent';
  }

  // ── Task State brief (consented fields only) ──
  const fields = await getConsentedFields(supabase, conversationId, agent.id);
  const { state, version } = await getTaskState(supabase, conversationId);
  const hasBrief = fields.length > 0;
  if (hasBrief) {
    await admin.from('share_log').insert({
      conversation_id: conversationId,
      user_id: user.id,
      agent_id: agent.id,
      fields,
      state_version: version,
    });
  }

  const finishTurn = async (replyId: string, replyText: string) => {
    if (!replyText.trim()) return;
    // Saved with the secret key: users can't insert assistant messages themselves.
    const { error } = await admin.from('messages').insert({
      conversation_id: conversationId,
      id: replyId,
      user_id: user.id,
      role: 'assistant',
      agent_id: agent.id,
      parts: [{ type: 'text', text: replyText }],
    });
    if (error) console.error('[chat] failed to save reply', error);
    try {
      await updateTaskStateAfterTurn(supabase, {
        conversationId,
        userId: user.id,
        agentId: agent.id,
        agentName: agent.name,
        userText,
        replyText,
        replyMessageId: replyId,
      });
    } catch (err) {
      console.error('[chat] task state update failed', err);
    }
  };

  // ════════════ External agent (creator's own server) ════════════
  if (agent.kind === 'external') {
    if (!config?.endpoint_url) return text('This agent has no endpoint configured.', 500);
    const request: ExternalRequest = {
      contract_version: '1',
      agent_id: agent.id,
      task_id: opaqueTaskId(conversationId, agent.id),
      messages: segment
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: textOf(m).slice(0, 20_000) }))
        .filter((m) => m.content),
      handoff: hasBrief ? briefForExternal(state, fields) : {},
      artifacts: fields.includes('artifacts')
        ? state.artifacts.map((a) => ({ id: a.id, title: clean(a.title, 120), summary: clean(a.summary, 500), version: a.version }))
        : [],
      first_turn_after_handoff: isHandoffTurn,
    };

    const stream = createUIMessageStream<AppUIMessage>({
      originalMessages: history,
      generateId: () => crypto.randomUUID(),
      execute: async ({ writer }) => {
        writer.write({ type: 'start', messageMetadata: { agentId: agent.id } });
        writer.write({ type: 'text-start', id: 'reply' });
        const say = (delta: string) => writer.write({ type: 'text-delta', id: 'reply', delta });
        try {
          let wanted: string[] = [];
          let proposals = 0;
          for await (const event of callExternalAgent(config.endpoint_url!, request)) {
            if (event.type === 'text') say(event.delta);
            else if (event.type === 'need_artifacts') wanted = event.ids;
            else if (event.type === 'state_update' && proposals < 3) {
              proposals++;
              await proposeChange(supabase, { conversationId, userId: user.id, agentId: agent.id, patch: event.patch });
              say('\n\n_Proposed an update to the task brief — review it in the side panel._');
            } else if (event.type === 'artifact') {
              say(`\n\n📎 _Produced: ${clean(event.title, 120)}_`);
            }
          }
          // One follow-up call if the agent asked for full artifact contents it's allowed to see.
          const allowed = wanted.filter((id) => request.artifacts.some((a) => a.id === id));
          if (allowed.length) {
            const { data: rows } = await supabase
              .from('artifacts')
              .select('id, content')
              .eq('conversation_id', conversationId)
              .in('id', allowed);
            const withContent = {
              ...request,
              artifacts: request.artifacts.map((a) => ({ ...a, content: rows?.find((r) => r.id === a.id)?.content?.slice(0, 60_000) })),
            };
            say('\n\n');
            for await (const event of callExternalAgent(config.endpoint_url!, withContent)) {
              if (event.type === 'text') say(event.delta);
            }
          }
        } catch (err) {
          say(`\n\n⚠️ ${err instanceof Error ? err.message : 'This agent failed to respond.'}`);
        }
        writer.write({ type: 'text-end', id: 'reply' });
      },
      onEnd: async ({ responseMessage }) => {
        const replyText = responseMessage.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
        await finishTurn(responseMessage.id, replyText);
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  // ════════════ No-code agent (runs on our server with the creator's prompt) ════════════
  let creatorKey: string | null = null;
  if (agent.creator_id) {
    const { data: secret } = await admin.from('agent_secrets').select('api_key_encrypted').eq('agent_id', agent.id).maybeSingle();
    if (secret) {
      try {
        creatorKey = decryptSecret(secret.api_key_encrypted);
      } catch (err) {
        console.error('[chat] could not decrypt creator key', err);
      }
    }
  }

  const realModel = agent.creator_id
    ? creatorKey
      ? getModel(agent.provider, agent.model, creatorKey)
      : null
    : getModel(agent.provider, agent.model);

  const canReadArtifacts = hasBrief && fields.includes('artifacts') && state.artifacts.length > 0;
  const instructions = buildInstructions({
    agentName: agent.name,
    creatorPrompt: config?.system_prompt ?? '',
    previousAgentName: isHandoffTurn ? previousAgentName : null,
    hasBrief,
    canReadArtifacts: Boolean(realModel) && canReadArtifacts,
    canProposeUpdates: Boolean(realModel),
  });

  const earlierTranscript = fields.includes('chat_history')
    ? history
        .slice(0, cut + 1)
        .map((m) => `${m.role === 'user' ? 'User' : 'Agent'}: ${textOf(m)}`)
        .join('\n')
        .slice(-20_000)
    : undefined;
  const briefMessages: ModelMessage[] = hasBrief
    ? [{ role: 'user', content: renderBrief({ state, fields, previousAgentName, earlierTranscript }) }]
    : [];
  const modelMessages = [...briefMessages, ...(await convertToModelMessages(await prepareForModel(supabase, segment)))];

  const model =
    realModel ??
    (await createDemoModel(
      demoReply({ agentName: agent.name, provider: agent.provider, userText, previousAgentName: isHandoffTurn ? previousAgentName : null, state, fields }),
    ));

  let proposalsThisTurn = 0;
  const tools = realModel
    ? {
        ...(canReadArtifacts && {
          read_artifact: tool({
            description: 'Get the full content of a file or output listed in the task brief, by its id.',
            inputSchema: z.object({ id: z.string().max(64) }),
            execute: async ({ id }) => {
              if (!state.artifacts.some((a) => a.id === id)) return { error: 'That item is not in the brief.' };
              const { data } = await supabase
                .from('artifacts')
                .select('title, version, content')
                .eq('id', id)
                .eq('conversation_id', conversationId)
                .maybeSingle();
              // Content written by earlier agents/users: handed over as fenced data, never as instructions.
              return data
                ? { title: data.title, version: data.version, content: fenceData(`${data.title} v${data.version}`, data.content) }
                : { error: 'Not found.' };
            },
          }),
        }),
        propose_task_state_update: tool({
          description:
            'Propose an update to the shared task brief, e.g. a decision you made and why, progress, or the next step. The user approves it before it is applied.',
          inputSchema: taskPatchSchema.partial(),
          execute: async (patch) => {
            if (++proposalsThisTurn > 3) return { status: 'Limit reached: at most 3 suggestions per reply.' };
            await proposeChange(supabase, { conversationId, userId: user.id, agentId: agent.id, patch });
            return { status: 'Sent to the user for approval.' };
          },
        }),
      }
    : undefined;

  const result = streamText({
    model,
    instructions,
    messages: modelMessages,
    tools,
    stopWhen: isStepCount(4),
    maxOutputTokens: 4000,
  });
  // Keep generating (and saving) even if the user closes the tab mid-reply.
  result.consumeStream();

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      originalMessages: history,
      generateMessageId: () => crypto.randomUUID(),
      messageMetadata: ({ part }) => (part.type === 'start' ? { agentId: agent.id } : undefined),
      onError: (error) => friendlyError(error, agent.provider),
      onEnd: async ({ responseMessage }) => {
        const replyText = responseMessage.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n');
        await finishTurn(responseMessage.id, replyText);
      },
    }),
  });
}

/** An agent's suggested change to the Task State. Never applied until the user approves it. */
async function proposeChange(
  supabase: SupabaseClient,
  opts: { conversationId: string; userId: string; agentId: string; patch: unknown },
) {
  const parsed = taskPatchSchema.partial().safeParse(opts.patch);
  if (!parsed.success) return;
  await insertPendingChange(supabase, { ...opts, source: 'agent', patch: parsed.data });
}

/** Turn provider errors into something a user can act on, without leaking internals. */
function friendlyError(error: unknown, provider: string | null): string {
  console.error('[chat] model error', error);
  const name = PROVIDER_LABEL[provider ?? ''] ?? 'The provider';
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) return `${name} rejected the API key.`;
    if (error.statusCode === 404) return `${name} doesn't recognise this agent's model name.`;
    if (error.statusCode === 429) return `${name} is rate-limiting requests. Try again shortly.`;
  }
  return `Something went wrong while ${name} was replying. Please try again.`;
}

/** Demo mode reply. On a handoff it shows exactly what the agent received, to prove the brief works. */
function demoReply(o: {
  agentName: string;
  provider: string | null;
  userText: string;
  previousAgentName: string | null;
  state: TaskState;
  fields: ShareableField[];
}): string {
  const providerName = PROVIDER_LABEL[o.provider ?? ''] ?? 'this provider';
  const has = (f: ShareableField) => o.fields.includes(f);
  const lines: string[] = [];

  if (o.previousAgentName) {
    const last = has('progress') ? o.state.progress.at(-1) : undefined;
    const next = (has('open_questions') && o.state.next_step) || o.userText || 'continue the task';
    lines.push(
      `**Picking up from ${o.previousAgentName}**${last ? ` (last step: ${clean(last.step, 120).replace(/\.+$/, '')})` : ''}, next I'll work on: "${clean(next, 160).replace(/\.+$/, '')}".`,
      '',
    );
  }

  if (o.fields.length) {
    lines.push('Here is what I received in the handoff brief:', '');
    if (has('goal')) lines.push(`- **Goal:** ${clean(o.state.goal, 200) || '—'}`);
    if (has('constraints')) {
      const c = o.state.constraints;
      const items = [c.tone && `tone: ${c.tone}`, c.format && `format: ${c.format}`, c.deadline && `deadline: ${c.deadline}`, ...c.must.map((m) => `must: ${m}`), ...c.must_not.map((m) => `must not: ${m}`)].filter(Boolean);
      lines.push(`- **Constraints:** ${items.length ? clean(items.join('; '), 300) : '—'}`);
    }
    if (has('decisions')) {
      lines.push(`- **Decisions I'll keep:** ${o.state.decisions.length ? o.state.decisions.map((d) => clean(`${d.what}${d.why ? ` (because ${d.why})` : ''}`, 160)).join('; ') : '—'}`);
    }
    if (has('progress')) lines.push(`- **Done so far:** ${o.state.progress.length ? o.state.progress.map((p) => clean(p.step, 100)).join('; ') : '—'}`);
    if (has('artifacts')) lines.push(`- **Files & outputs:** ${o.state.artifacts.length ? o.state.artifacts.map((a) => `${clean(a.title, 80)} v${a.version}`).join(', ') : '—'}`);
    lines.push('');
  } else if (o.previousAgentName) {
    lines.push("You didn't share the task brief with me, so I only see your latest messages.", '');
  }

  if (!o.previousAgentName && o.userText) {
    lines.push(`You said: "${clean(o.userText, 200)}"`, '');
  }
  lines.push(`_Demo reply from ${o.agentName}: no ${providerName} API key is set, so this isn't a real answer._`);
  return lines.join('\n');
}
