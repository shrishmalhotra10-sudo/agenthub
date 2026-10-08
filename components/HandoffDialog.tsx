'use client';

import { useEffect, useState, useTransition } from 'react';
import { confirmHandoff, previewHandoff } from '@/app/chat/task-actions';
import { FIELD_LABEL, SHAREABLE_FIELDS, type ShareableField } from '@/lib/taskstate/schema';
import { PROVIDER_LABEL, type PublicAgent } from '@/lib/chat/types';

export function HandoffDialog(props: {
  conversationId: string;
  agents: PublicAgent[];
  initialAgentId: string;
  currentNextStep: string;
  onClose: () => void;
  onConfirmed: (agentId: string) => void;
}) {
  const [agentId, setAgentId] = useState(props.initialAgentId);
  const agent = props.agents.find((a) => a.id === agentId);
  const [fields, setFields] = useState<ShareableField[]>(agent?.needs ?? []);
  const [nextStep, setNextStep] = useState(props.currentNextStep);
  const [preview, setPreview] = useState('Loading preview…');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // When the target agent changes, start from what its manifest asks for.
  function pickAgent(id: string) {
    setAgentId(id);
    setFields(props.agents.find((a) => a.id === id)?.needs ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    previewHandoff(props.conversationId, agentId, fields)
      .then((text) => !cancelled && setPreview(text))
      .catch(() => !cancelled && setPreview('Could not load the preview.'));
    return () => {
      cancelled = true;
    };
  }, [props.conversationId, agentId, fields]);

  function toggle(field: ShareableField) {
    setFields((prev) => (prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]));
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        await confirmHandoff(props.conversationId, agentId, fields, nextStep);
        props.onConfirmed(agentId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Handoff failed.');
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Hand off to another agent">
      <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <h2 className="text-lg font-semibold">Hand off this task</h2>
          <p className="text-sm text-zinc-500">The next agent starts with a brief of what&apos;s been done — you choose exactly what it sees.</p>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Next agent</span>
            <select
              value={agentId}
              onChange={(e) => pickAgent(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 bg-white px-2 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {props.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.kind === 'external' ? 'Hosted by creator' : PROVIDER_LABEL[a.provider ?? ''] ?? ''}
                  {a.live ? '' : ' (demo)'}
                </option>
              ))}
            </select>
            {agent && <span className="block text-xs text-zinc-500">{agent.description}</span>}
          </label>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What can {agent?.name ?? 'this agent'} see?</legend>
            <p className="text-xs text-zinc-500">
              Pre-ticked: what this agent says it needs. You can change it, and revoke it later from the side panel.
            </p>
            {agent && (agent.kind === 'external' || agent.byCreator) && (
              <p className="text-xs text-amber-600">
                This agent is run by its creator ({agent.kind === 'external' ? 'on their own server' : 'on their own AI account'}), so what you share and
                the messages you send it pass through the creator&apos;s systems.
              </p>
            )}
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {SHAREABLE_FIELDS.map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={fields.includes(f)} onChange={() => toggle(f)} />
                  {FIELD_LABEL[f]}
                  {agent?.needs.includes(f) && <span className="text-xs text-zinc-400">(requested)</span>}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block space-y-1">
            <span className="text-sm font-medium">What should it do next? (optional)</span>
            <input
              value={nextStep}
              onChange={(e) => setNextStep(e.target.value)}
              maxLength={500}
              placeholder="e.g. Write a cover letter for the Acme product manager role"
              className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            />
          </label>

          <div className="space-y-1">
            <span className="text-sm font-medium">Preview — exactly what the agent will receive</span>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-800">{preview}</pre>
          </div>
          {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <button onClick={props.onClose} className="rounded-lg px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={pending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            {pending ? 'Handing off…' : `Hand off to ${agent?.name ?? 'agent'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
