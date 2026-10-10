'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Markdown } from './Markdown';
import { HandoffDialog } from './HandoffDialog';
import { TaskPanel, type PanelData } from './TaskPanel';
import { deleteConversation } from '@/app/chat/actions';
import { PROVIDER_LABEL, type AppUIMessage, type PublicAgent } from '@/lib/chat/types';

type Attachment = { id: string; name: string; mediaType: string; url: string; readable: boolean };

const ACCEPT =
  '.pdf,.docx,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.cs,.php,.sh,.sql';
const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 20_000;

export function ChatView(props: {
  conversationId: string;
  title: string;
  initialMessages: AppUIMessage[];
  agents: PublicAgent[];
  initialAgentId: string | null;
  panel: PanelData;
}) {
  const { conversationId, agents } = props;
  const router = useRouter();
  const [agentId, setAgentId] = useState(props.initialAgentId);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(true); // desktop: side column
  const [panelSheet, setPanelSheet] = useState(false); // phone/tablet: full-screen sheet
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const selected = agentId ? agentsById.get(agentId) : undefined;

  // Send only the newest message + chosen agent; the server loads history itself.
  const [transport] = useState(
    () =>
      new DefaultChatTransport<AppUIMessage>({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ id, messages, body }) => ({
          body: { conversationId: id, message: messages[messages.length - 1], agentId: body?.agentId },
        }),
      }),
  );

  const { messages, sendMessage, status, stop, error } = useChat<AppUIMessage>({
    id: conversationId,
    messages: props.initialMessages,
    transport,
    onFinish: () => router.refresh(), // refresh sidebar (chat title)
  });

  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, status]);

  function send() {
    const text = input.trim();
    if ((!text && !attachments.length) || busy || uploading || !agentId) return;
    sendMessage(
      {
        text,
        files: attachments.map((a) => ({
          type: 'file' as const,
          mediaType: a.mediaType,
          filename: a.name,
          url: a.url,
        })),
      },
      { body: { agentId } },
    );
    setInput('');
    setAttachments([]);
    setUploadError(null);
  }

  async function uploadFiles(list: FileList | null) {
    setUploadError(null);
    const files = Array.from(list ?? []).slice(0, MAX_ATTACHMENTS - attachments.length);
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        setUploadError(`${file.name} is larger than 10 MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('conversationId', conversationId);
        const res = await fetch('/api/upload', { method: 'POST', body: form });
        if (!res.ok) {
          setUploadError(`${file.name}: ${await res.text()}`);
        } else {
          const uploaded = (await res.json()) as Attachment;
          setAttachments((prev) => [...prev, uploaded]);
          if (!uploaded.readable) setUploadError(`${file.name}: no readable text found (scanned PDF?).`);
        }
      } catch {
        setUploadError(`${file.name}: upload failed.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // Which agent the most recent reply came from, to show a "switching" hint.
  const lastReplyAgentId = [...messages].reverse().find((m) => m.role === 'assistant')?.metadata?.agentId;
  let previousAssistantAgent: string | undefined;

  // Switching agents mid-task goes through the handoff dialog (consent + brief preview).
  function chooseAgent(id: string) {
    if (lastReplyAgentId && id !== lastReplyAgentId) setHandoffTarget(id);
    else setAgentId(id);
  }

  function onHandedOff(id: string, nextStep: string) {
    const target = agentsById.get(id);
    setHandoffTarget(null);
    setAgentId(id);
    router.refresh();
    const next = nextStep.trim();
    sendMessage(
      { text: `Handing off to ${target?.name ?? 'the next agent'}.${next ? ` Next: ${next}` : ' Please continue from the brief.'}` },
      { body: { agentId: id } },
    );
  }

  function toggleBrief() {
    if (window.matchMedia('(min-width: 1024px)').matches) setShowPanel((v) => !v);
    else setPanelSheet(true);
  }
  const pendingCount = props.panel.pending.length;
  // The agent currently "holding" the task can't be a handoff target.
  const holderId = lastReplyAgentId ?? agentId;
  const handoffAgents = agents.filter((a) => a.id !== holderId);

  return (
    <div className="flex h-full min-h-0">
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Header: title + agent picker */}
      <header className="space-y-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <Link href="/chat" className="text-zinc-500 md:hidden" aria-label="All chats">←</Link>
          <h1 className="min-w-0 flex-1 truncate font-medium" title={props.title}>{props.title}</h1>
          <form
            action={deleteConversation.bind(null, conversationId)}
            onSubmit={(e) => {
              if (!confirm('Delete this chat and its files?')) e.preventDefault();
            }}
          >
            <button className="text-sm text-zinc-400 hover:text-red-600" title="Delete this chat">
              Delete
            </button>
          </form>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="text-zinc-500">Agent</span>
          <select
            value={agentId ?? ''}
            onChange={(e) => chooseAgent(e.target.value)}
            disabled={busy}
            className="min-w-0 max-w-full flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm sm:flex-none dark:border-zinc-700 dark:bg-zinc-900"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.kind === 'external' ? 'Hosted by creator' : PROVIDER_LABEL[a.provider ?? ''] ?? ''}
                {a.live ? '' : ' (demo)'}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => setHandoffTarget(handoffAgents[0]?.id ?? null)}
          disabled={busy || messages.length === 0}
          className="rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
          title="Pass this task to another agent with a brief"
        >
          Hand off →
        </button>
        <button
          onClick={toggleBrief}
          className="rounded-lg px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          aria-pressed={showPanel}
        >
          Task brief
          {pendingCount > 0 && (
            <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-medium text-white" aria-label={`${pendingCount} waiting for approval`}>
              {pendingCount}
            </span>
          )}
        </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
          {messages.length === 0 && selected && (
            <div className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-500 dark:border-zinc-700">
              <p className="font-medium text-zinc-700 dark:text-zinc-300">{selected.name}</p>
              <p>{selected.description}</p>
            </div>
          )}

          {messages.map((m, index) => {
            const isLast = index === messages.length - 1;
            const replyAgentId = m.metadata?.agentId ?? (m.role === 'assistant' && isLast ? agentId : undefined);
            const replyAgent = replyAgentId ? agentsById.get(replyAgentId) : undefined;
            const switched =
              m.role === 'assistant' &&
              previousAssistantAgent !== undefined &&
              replyAgentId !== previousAssistantAgent;
            if (m.role === 'assistant') previousAssistantAgent = replyAgentId ?? undefined;

            return (
              <div key={m.id}>
                {switched && (
                  <div className="my-4 flex items-center gap-3 text-xs text-zinc-400">
                    <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                    Switched to {replyAgent?.name ?? 'another agent'}
                    <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                )}
                {m.role === 'user' ? (
                  <div className="flex flex-col items-end gap-2">
                    <FileChips parts={m.parts} />
                    {m.parts.map((p, i) =>
                      p.type === 'text' && p.text ? (
                        <div
                          key={i}
                          className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-100 px-4 py-2.5 text-[15px] dark:bg-zinc-800"
                        >
                          {p.text}
                        </div>
                      ) : null,
                    )}
                  </div>
                ) : (
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {replyAgent?.name ?? 'Agent'}
                      </span>
                      {replyAgent?.provider && <span>{PROVIDER_LABEL[replyAgent.provider]}</span>}
                    </div>
                    {m.parts.map((p, i) =>
                      p.type === 'text' ? (
                        <Markdown key={i}>{p.text}</Markdown>
                      ) : p.type.startsWith('tool-') ? (
                        <p key={i} className="text-xs text-zinc-400">
                          {p.type === 'tool-read_artifact' ? '📄 Read a file from the brief' : '📝 Suggested an update to the brief'}
                        </p>
                      ) : null,
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {status === 'submitted' && (
            <p className="animate-pulse text-sm text-zinc-500">{selected?.name ?? 'Agent'} is thinking…</p>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              {error.message || 'Something went wrong.'}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="mx-auto max-w-3xl">
          {messages.length > 0 && lastReplyAgentId && agentId !== lastReplyAgentId && selected && (
            <p className="mb-2 text-xs text-amber-600">
              Next reply will come from {selected.name}, using the brief you shared with it.
            </p>
          )}
          {input.length > MAX_MESSAGE_CHARS * 0.9 && (
            <p className="mb-2 text-xs text-amber-600">
              {input.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()} characters. For longer text, attach it as a file.
            </p>
          )}
          {(attachments.length > 0 || uploading > 0) && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <span key={a.id} className="flex items-center gap-1 rounded-lg bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
                  📎 {a.name}
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    className="ml-1 text-zinc-400 hover:text-zinc-700"
                    aria-label={`Remove ${a.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              {uploading > 0 && <span className="px-2 py-1 text-xs text-zinc-500">Uploading…</span>}
            </div>
          )}
          {uploadError && <p className="mb-2 text-xs text-red-600">{uploadError}</p>}
          <div className="flex items-end gap-2 rounded-2xl border border-zinc-300 p-2 dark:border-zinc-700">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => uploadFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_ATTACHMENTS}
              className="rounded-lg px-2 py-1.5 text-lg text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
              title="Attach PDF, DOCX, images or code"
              aria-label="Attach files"
            >
              📎
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              maxLength={MAX_MESSAGE_CHARS}
              aria-label="Message"
              placeholder={selected ? `Message ${selected.name}…` : 'Pick an agent first'}
              className="max-h-48 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 text-[15px] outline-none"
            />
            {busy ? (
              <button
                onClick={() => stop()}
                className="rounded-xl bg-zinc-200 px-3 py-2 text-sm font-medium dark:bg-zinc-700"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={send}
                disabled={(!input.trim() && !attachments.length) || uploading > 0 || !agentId}
                className="rounded-xl bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
    {showPanel && (
      <div className="hidden w-80 shrink-0 lg:block xl:w-96">
        <TaskPanel conversationId={conversationId} data={props.panel} />
      </div>
    )}
    {panelSheet && (
      <div className="fixed inset-0 z-40 flex flex-col bg-zinc-50 lg:hidden dark:bg-zinc-900" role="dialog" aria-modal="true" aria-label="Task brief">
        <div className="flex justify-end border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <button onClick={() => setPanelSheet(false)} className="text-sm text-zinc-600 hover:underline dark:text-zinc-300">
            Close ✕
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <TaskPanel conversationId={conversationId} data={props.panel} />
        </div>
      </div>
    )}
    {handoffTarget && (
      <HandoffDialog
        conversationId={conversationId}
        agents={handoffAgents}
        initialAgentId={handoffTarget}
        currentNextStep={props.panel.state.next_step}
        onClose={() => setHandoffTarget(null)}
        onConfirmed={onHandedOff}
      />
    )}
    </div>
  );
}

function FileChips({ parts }: { parts: AppUIMessage['parts'] }) {
  const files = parts.filter((p) => p.type === 'file');
  if (!files.length) return null;
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {files.map((f, i) =>
        f.mediaType.startsWith('image/') ? (
          // eslint-disable-next-line @next/next/no-img-element -- private, auth-gated file URL
          <img key={i} src={f.url} alt={f.filename ?? 'image'} className="max-h-48 rounded-lg border border-zinc-200 dark:border-zinc-700" />
        ) : (
          <a
            key={i}
            href={f.url}
            className="rounded-lg bg-zinc-100 px-2 py-1 text-xs hover:underline dark:bg-zinc-800"
          >
            📎 {f.filename ?? 'file'}
          </a>
        ),
      )}
    </div>
  );
}
