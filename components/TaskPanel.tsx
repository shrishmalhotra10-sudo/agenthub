'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { decideChange, getArtifactContent, revokeConsent, saveTaskStateAction } from '@/app/chat/task-actions';
import { FIELD_LABEL, type ShareableField, type TaskState } from '@/lib/taskstate/schema';

export type PanelData = {
  state: TaskState;
  version: number;
  pending: { id: number; summary: string; agentName: string; patch: Record<string, unknown> }[];
  consents: { id: string; agentName: string; fields: ShareableField[] }[];
  activity: { key: string; text: string; at: string }[];
};

const lines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

export function TaskPanel({ conversationId, data }: { conversationId: string; data: PanelData }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<{ title: string; version: number; content: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const s = data.state;

  // Edit form state (lists edited as one item per line).
  const [form, setForm] = useState(() => toForm(s));
  const startEdit = () => {
    setForm(toForm(s));
    setEditing(true);
  };

  function save() {
    setError(null);
    const next: TaskState = {
      ...s,
      goal: form.goal,
      constraints: {
        tone: form.tone,
        format: form.format,
        budget: form.budget,
        deadline: form.deadline,
        must: lines(form.must),
        must_not: lines(form.must_not),
      },
      decisions: lines(form.decisions).map((l) => {
        const [what, ...why] = l.split(' — ');
        const prev = s.decisions.find((d) => d.what === what.trim());
        return { what: what.trim(), why: why.join(' — ').trim(), by: prev?.by || 'user' };
      }),
      open_questions: lines(form.open_questions),
      next_step: form.next_step,
      glossary: lines(form.glossary).map((l) => {
        const [term, ...meaning] = l.split('=');
        return { term: term.trim(), meaning: meaning.join('=').trim() };
      }),
    };
    startTransition(async () => {
      const res = await saveTaskStateAction(conversationId, next, data.version);
      if (!res.ok) setError(res.error);
      else {
        setEditing(false);
        router.refresh();
      }
    });
  }

  const act = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      router.refresh();
    });

  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-l border-zinc-200 bg-zinc-50 text-sm dark:border-zinc-800 dark:bg-zinc-900" aria-label="Task brief">
      <div className="sticky top-0 flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h2 className="font-semibold">Task brief</h2>
          <p className="text-xs text-zinc-500">What the next agent will know · v{data.version}</p>
        </div>
        {editing ? (
          <div className="flex gap-2">
            <button onClick={() => setEditing(false)} className="text-xs text-zinc-500 hover:underline">Cancel</button>
            <button onClick={save} disabled={pending} className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900">
              Save
            </button>
          </div>
        ) : (
          <button onClick={startEdit} className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-800">
            Edit
          </button>
        )}
      </div>

      <div className="space-y-5 px-4 py-4">
        {error && <p className="text-xs text-red-600" role="alert">{error}</p>}

        {data.pending.length > 0 && (
          <Section title="Waiting for your approval">
            {data.pending.map((c) => (
              <div key={c.id} className="rounded-lg border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950">
                <p className="font-medium">From {c.agentName}&apos;s reply: {c.summary}</p>
                <PatchDetails patch={c.patch} />
                <div className="mt-2 flex gap-2">
                  <button onClick={() => act(() => decideChange(conversationId, c.id, true))} className="rounded-md bg-zinc-900 px-2 py-0.5 text-xs text-white dark:bg-white dark:text-zinc-900">Approve</button>
                  <button onClick={() => act(() => decideChange(conversationId, c.id, false))} className="rounded-md px-2 py-0.5 text-xs hover:bg-amber-100 dark:hover:bg-amber-900">Reject</button>
                </div>
              </div>
            ))}
          </Section>
        )}

        {editing ? (
          <div className="space-y-3">
            <Field label="Goal"><textarea rows={2} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} className={input} /></Field>
            <div className="grid grid-cols-2 gap-2">
              {(['tone', 'format', 'budget', 'deadline'] as const).map((k) => (
                <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
                  <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={input} />
                </Field>
              ))}
            </div>
            <Field label="Must (one per line)"><textarea rows={2} value={form.must} onChange={(e) => setForm({ ...form, must: e.target.value })} className={input} /></Field>
            <Field label="Must not (one per line)"><textarea rows={2} value={form.must_not} onChange={(e) => setForm({ ...form, must_not: e.target.value })} className={input} /></Field>
            <Field label="Decisions (one per line, “what — why”)"><textarea rows={3} value={form.decisions} onChange={(e) => setForm({ ...form, decisions: e.target.value })} className={input} /></Field>
            <Field label="Open questions (one per line)"><textarea rows={2} value={form.open_questions} onChange={(e) => setForm({ ...form, open_questions: e.target.value })} className={input} /></Field>
            <Field label="Next step"><input value={form.next_step} onChange={(e) => setForm({ ...form, next_step: e.target.value })} className={input} /></Field>
            <Field label="Glossary (one per line, “term = meaning”)"><textarea rows={2} value={form.glossary} onChange={(e) => setForm({ ...form, glossary: e.target.value })} className={input} /></Field>
          </div>
        ) : (
          <>
            <Section title="Goal"><p>{s.goal || <Empty />}</p></Section>
            <Section title="Constraints & preferences">
              <List
                items={[
                  s.constraints.tone && `Tone: ${s.constraints.tone}`,
                  s.constraints.format && `Format: ${s.constraints.format}`,
                  s.constraints.budget && `Budget: ${s.constraints.budget}`,
                  s.constraints.deadline && `Deadline: ${s.constraints.deadline}`,
                  ...s.constraints.must.map((m) => `Must: ${m}`),
                  ...s.constraints.must_not.map((m) => `Must not: ${m}`),
                ].filter(Boolean) as string[]}
              />
            </Section>
            <Section title="Decisions">
              <List items={s.decisions.map((d) => `${d.what}${d.why ? ` — because ${d.why}` : ''}${d.by ? ` (${d.by})` : ''}`)} />
            </Section>
            <Section title="Progress">
              {s.earlier_progress && <p className="mb-1 text-xs text-zinc-500">Earlier: {s.earlier_progress}</p>}
              <List items={s.progress.map((p) => `${p.step}${p.outcome ? ` → ${p.outcome}` : ''}`)} />
            </Section>
            <Section title="Files & outputs">
              {s.artifacts.length ? (
                <ul className="space-y-1">
                  {s.artifacts.map((a) => (
                    <li key={a.id}>
                      <button
                        onClick={() => startTransition(async () => setArtifact(await getArtifactContent(conversationId, a.id)))}
                        className="text-left hover:underline"
                      >
                        📄 {a.title} <span className="text-xs text-zinc-500">v{a.version}{a.by ? ` · ${a.by}` : ''}</span>
                      </button>
                      {a.summary && <p className="text-xs text-zinc-500">{a.summary}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty />
              )}
            </Section>
            <Section title="Open questions"><List items={s.open_questions} /></Section>
            <Section title="Next step"><p>{s.next_step || <Empty />}</p></Section>
            {s.glossary.length > 0 && <Section title="Glossary"><List items={s.glossary.map((g) => `${g.term} = ${g.meaning}`)} /></Section>}
          </>
        )}

        <Section title="Who can see this task">
          {data.consents.length ? (
            <ul className="space-y-2">
              {data.consents.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-2">
                  <span>
                    <span className="font-medium">{c.agentName}</span>
                    <span className="block text-xs text-zinc-500">{c.fields.map((f) => FIELD_LABEL[f]).join(', ') || 'Nothing'}</span>
                  </span>
                  <button onClick={() => act(() => revokeConsent(conversationId, c.id))} className="shrink-0 text-xs text-red-600 hover:underline">
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-zinc-500">No agent has been given the brief yet. Use “Hand off” to share it.</p>
          )}
        </Section>

        <Section title="Activity">
          {data.activity.length ? (
            <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              {data.activity.map((a) => (
                <li key={a.key}>
                  <span className="text-zinc-400">{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> {a.text}
                </li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>
      </div>

      {artifact && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={() => setArtifact(null)}>
          <div className="max-h-[85dvh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-5 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">{artifact.title} <span className="text-xs text-zinc-500">v{artifact.version}</span></h3>
              <button onClick={() => setArtifact(null)} className="text-sm text-zinc-500 hover:underline">Close</button>
            </div>
            <pre className="whitespace-pre-wrap text-sm">{artifact.content}</pre>
          </div>
        </div>
      )}
    </aside>
  );
}

const input = 'w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950';

function toForm(s: TaskState) {
  return {
    goal: s.goal,
    tone: s.constraints.tone,
    format: s.constraints.format,
    budget: s.constraints.budget,
    deadline: s.constraints.deadline,
    must: s.constraints.must.join('\n'),
    must_not: s.constraints.must_not.join('\n'),
    decisions: s.decisions.map((d) => (d.why ? `${d.what} — ${d.why}` : d.what)).join('\n'),
    open_questions: s.open_questions.join('\n'),
    next_step: s.next_step,
    glossary: s.glossary.map((g) => `${g.term} = ${g.meaning}`).join('\n'),
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

function List({ items }: { items: string[] }) {
  if (!items.length) return <Empty />;
  return (
    <ul className="list-disc space-y-0.5 pl-4">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Empty() {
  return <span className="text-xs text-zinc-400">—</span>;
}

function PatchDetails({ patch }: { patch: Record<string, unknown> }) {
  const rows: string[] = [];
  const p = patch as {
    goal?: string; next_step?: string;
    add_decisions?: { what: string; why: string }[];
    add_progress?: { step: string; outcome: string }[];
    add_must?: string[]; add_must_not?: string[];
  };
  if (p.goal) rows.push(`Goal → ${p.goal}`);
  for (const d of p.add_decisions ?? []) rows.push(`Decision: ${d.what}${d.why ? ` (because ${d.why})` : ''}`);
  for (const s of p.add_progress ?? []) rows.push(`Progress: ${s.step}${s.outcome ? ` → ${s.outcome}` : ''}`);
  for (const m of p.add_must ?? []) rows.push(`Must: ${m}`);
  for (const m of p.add_must_not ?? []) rows.push(`Must not: ${m}`);
  if (p.next_step) rows.push(`Next step → ${p.next_step}`);
  if (!rows.length) return null;
  return (
    <ul className="mt-1 list-disc pl-4 text-xs">
      {rows.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}
