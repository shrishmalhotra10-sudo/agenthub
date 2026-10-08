'use client';

import { useActionState, useState } from 'react';
import { saveAgent, type SaveState } from '@/app/creator/actions';
import { CATEGORIES } from '@/lib/chat/types';
import { FIELD_LABEL, SHAREABLE_FIELDS, type ShareableField } from '@/lib/taskstate/schema';

export type AgentFormValues = {
  id?: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  kind: 'nocode' | 'external';
  provider: string;
  model: string;
  system_prompt: string;
  endpoint_url: string;
  needs: ShareableField[];
  is_published: boolean;
  hasApiKey: boolean;
};

const MODEL_HINT: Record<string, string> = {
  openai: 'e.g. gpt-6-luna',
  anthropic: 'e.g. claude-sonnet-5-5',
  google: 'e.g. gemini-flash-latest',
};

export function AgentForm({ initial }: { initial: AgentFormValues }) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveAgent, {});
  const [kind, setKind] = useState(initial.kind);
  const [provider, setProvider] = useState(initial.provider || 'openai');

  return (
    <form action={action} className="space-y-5">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Label text="Name"><input name="name" required maxLength={60} defaultValue={initial.name} className={input} /></Label>
        <Label text="Web address (marketplace/…)">
          <input name="slug" required pattern="[a-z0-9-]{3,48}" defaultValue={initial.slug} placeholder="my-agent" className={input} />
        </Label>
      </div>
      <Label text="Description"><textarea name="description" rows={2} maxLength={500} defaultValue={initial.description} className={input} /></Label>
      <Label text="Category">
        <select name="category" defaultValue={initial.category || 'general'} className={input}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">How does your agent run?</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="kind" value="nocode" checked={kind === 'nocode'} onChange={() => setKind('nocode')} />
          <span><b>No-code</b> — AgentHub runs it with your instructions and your AI provider key.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="kind" value="external" checked={kind === 'external'} onChange={() => setKind('external')} />
          <span><b>My own server</b> — AgentHub sends requests to your HTTPS endpoint (see the agent contract).</span>
        </label>
      </fieldset>

      {kind === 'nocode' ? (
        <div className="space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="grid gap-4 sm:grid-cols-2">
            <Label text="AI provider">
              <select name="provider" value={provider} onChange={(e) => setProvider(e.target.value)} className={input}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google Gemini</option>
              </select>
            </Label>
            <Label text="Model"><input name="model" required defaultValue={initial.model} placeholder={MODEL_HINT[provider]} className={input} /></Label>
          </div>
          <Label text="Instructions (system prompt) — never shown to users">
            <textarea name="system_prompt" rows={6} maxLength={20000} defaultValue={initial.system_prompt} className={input} />
          </Label>
          <Label text={initial.hasApiKey ? 'API key (saved — leave blank to keep it)' : 'Your API key for this provider'}>
            <input name="api_key" type="password" autoComplete="off" placeholder={initial.hasApiKey ? '••••••••' : 'sk-…'} className={input} />
            <span className="block text-xs text-zinc-500">Encrypted on the server. Never shown again, never sent to browsers. Without it, your agent runs in demo mode.</span>
          </Label>
        </div>
      ) : (
        <div className="space-y-2 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <Label text="Endpoint URL (https://…)">
            <input name="endpoint_url" type="url" required defaultValue={initial.endpoint_url} placeholder="https://my-agent.example.com/agenthub" className={input} />
          </Label>
          <p className="text-xs text-zinc-500">AgentHub will POST the contract request here. See docs/AGENT_CONTRACT.md in the repo.</p>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What should your agent receive when a task is handed to it? (manifest)</legend>
        <p className="text-xs text-zinc-500">Users see this list and decide what to actually share.</p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {SHAREABLE_FIELDS.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="needs" value={f} defaultChecked={initial.needs.includes(f)} /> {FIELD_LABEL[f]}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="is_published" defaultChecked={initial.is_published} /> Publish to the marketplace
      </label>

      {state.error && <p className="text-sm text-red-600" role="alert">{state.error}</p>}
      <button disabled={pending} className="rounded-lg bg-zinc-900 px-5 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900">
        {pending ? 'Saving…' : 'Save agent'}
      </button>
    </form>
  );
}

const input = 'w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700';

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{text}</span>
      {children}
    </label>
  );
}
