import { z } from 'zod';

/**
 * The Task State: a model-agnostic brief that travels with a task between agents.
 * Owned by the user. Every string has a length cap so it stays a brief, not a log.
 */

const s = (max: number) => z.string().trim().max(max);

export const taskStateSchema = z.object({
  goal: s(1000).default(''),
  constraints: z
    .object({
      tone: s(200).default(''),
      format: s(200).default(''),
      budget: s(200).default(''),
      deadline: s(200).default(''),
      must: z.array(s(300)).max(20).default([]),
      must_not: z.array(s(300)).max(20).default([]),
    })
    .default({ tone: '', format: '', budget: '', deadline: '', must: [], must_not: [] }),
  decisions: z.array(z.object({ what: s(300), why: s(500).default(''), by: s(60).default('') })).max(40).default([]),
  progress: z
    .array(z.object({ step: s(200), outcome: s(500).default(''), by: s(60).default(''), at: s(40).default('') }))
    .max(60)
    .default([]),
  /** Older progress, compressed into a short paragraph to save tokens. */
  earlier_progress: s(1500).default(''),
  artifacts: z
    .array(z.object({ id: s(64), title: s(120), summary: s(500).default(''), version: z.number().int().default(1), by: s(60).default('') }))
    .max(40)
    .default([]),
  open_questions: z.array(s(300)).max(20).default([]),
  next_step: s(500).default(''),
  glossary: z.array(z.object({ term: s(80), meaning: s(300) })).max(50).default([]),
});

export type TaskState = z.infer<typeof taskStateSchema>;

export const emptyTaskState = (): TaskState => taskStateSchema.parse({});

/** Parse anything (DB json, user edit) into a valid, capped Task State. */
export function normalizeTaskState(raw: unknown): TaskState {
  const parsed = taskStateSchema.safeParse(trimLists(raw));
  return parsed.success ? parsed.data : emptyTaskState();
}

/** Keeps every list within its cap (newest kept), so one extra item can never invalidate the whole brief. */
function trimLists(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return {};
  const s = structuredClone(raw) as Record<string, unknown> & { constraints?: Record<string, unknown> };
  const keepLast = (v: unknown, n: number) => (Array.isArray(v) ? v.slice(-n) : v);
  const keepFirst = (v: unknown, n: number) => (Array.isArray(v) ? v.slice(0, n) : v);
  s.decisions = keepLast(s.decisions, 40);
  s.progress = keepLast(s.progress, 60);
  s.artifacts = keepLast(s.artifacts, 40);
  s.glossary = keepLast(s.glossary, 50);
  s.open_questions = keepFirst(s.open_questions, 20);
  if (s.constraints && typeof s.constraints === 'object') {
    s.constraints.must = keepFirst(s.constraints.must, 20);
    s.constraints.must_not = keepFirst(s.constraints.must_not, 20);
  }
  return s;
}

/** The parts of a Task State an agent can be given. `chat_history` = earlier raw transcript. */
export const SHAREABLE_FIELDS = [
  'goal',
  'constraints',
  'decisions',
  'progress',
  'artifacts',
  'open_questions',
  'glossary',
  'chat_history',
] as const;
export type ShareableField = (typeof SHAREABLE_FIELDS)[number];

export const FIELD_LABEL: Record<ShareableField, string> = {
  goal: 'Goal',
  constraints: 'Constraints & preferences',
  decisions: 'Decisions (and why)',
  progress: 'Progress so far',
  artifacts: 'Files & outputs',
  open_questions: 'Open questions & next step',
  glossary: 'Glossary',
  chat_history: 'Full earlier chat transcript',
};

export const fieldsSchema = z.array(z.enum(SHAREABLE_FIELDS)).max(SHAREABLE_FIELDS.length);

/** Reads an agent's manifest ({ needs: [...] }) safely. */
export function manifestNeeds(manifest: unknown): ShareableField[] {
  const needs = (manifest as { needs?: unknown })?.needs;
  const parsed = fieldsSchema.safeParse(needs);
  return parsed.success ? parsed.data : [];
}

/**
 * A change to the Task State, proposed by the extractor or an agent.
 * Nullable instead of optional so it works with every provider's structured output.
 */
export const taskPatchSchema = z.object({
  goal: s(1000).nullable().describe('The user\'s overall goal, only if it is new or changed'),
  tone: s(200).nullable(),
  format: s(200).nullable(),
  budget: s(200).nullable(),
  deadline: s(200).nullable(),
  add_must: z.array(s(300)).max(10).nullable().describe('New hard requirements stated by the user'),
  add_must_not: z.array(s(300)).max(10).nullable().describe('New things the user does not want'),
  add_decisions: z
    .array(z.object({ what: s(300), why: s(500) }))
    .max(10)
    .nullable()
    .describe('Decisions made in this turn and the reason for each'),
  add_progress: z
    .array(z.object({ step: s(200), outcome: s(500) }))
    .max(5)
    .nullable()
    .describe('What was done in this turn, as short steps with outcomes'),
  open_questions: z.array(s(300)).max(20).nullable().describe('Full replacement list of unanswered questions'),
  next_step: s(500).nullable().describe('What should happen next'),
  add_glossary: z.array(z.object({ term: s(80), meaning: s(300) })).max(10).nullable(),
  artifact: z
    .object({ title: s(120), summary: s(500) })
    .nullable()
    .describe('Set only if the reply contains a deliverable (e.g. a resume, draft, plan). Short title + 1-2 sentence summary.'),
});
export type TaskPatch = z.infer<typeof taskPatchSchema>;

const MAX_DETAILED_PROGRESS = 12;

/** Apply a patch. `by` is who made the change (agent name or "user"). Pure function. */
export function applyPatch(state: TaskState, patch: Partial<TaskPatch>, by: string): TaskState {
  const next: TaskState = structuredClone(state);
  const now = new Date().toISOString();
  if (patch.goal) next.goal = patch.goal;
  for (const key of ['tone', 'format', 'budget', 'deadline'] as const) {
    const v = patch[key];
    if (v) next.constraints[key] = v;
  }
  const addUnique = (list: string[], items: string[] | null | undefined) => {
    for (const item of items ?? []) if (item && !list.includes(item)) list.push(item);
  };
  addUnique(next.constraints.must, patch.add_must);
  addUnique(next.constraints.must_not, patch.add_must_not);
  for (const d of patch.add_decisions ?? []) next.decisions.push({ what: d.what, why: d.why, by });
  for (const p of patch.add_progress ?? []) next.progress.push({ step: p.step, outcome: p.outcome, by, at: now });
  if (patch.open_questions) next.open_questions = patch.open_questions;
  if (patch.next_step) next.next_step = patch.next_step;
  for (const g of patch.add_glossary ?? []) {
    const existing = next.glossary.find((x) => x.term.toLowerCase() === g.term.toLowerCase());
    if (existing) existing.meaning = g.meaning;
    else next.glossary.push(g);
  }

  // Keep the brief short: fold old progress into a one-paragraph summary.
  while (next.progress.length > MAX_DETAILED_PROGRESS) {
    const old = next.progress.shift()!;
    const line = `${old.step}${old.outcome ? `: ${old.outcome}` : ''}${old.by ? ` (${old.by})` : ''}. `;
    next.earlier_progress = (next.earlier_progress + line).slice(-1500);
  }
  return normalizeTaskState(next);
}

/** One-line human summary of a patch, for the change history. */
export function describePatch(patch: Partial<TaskPatch>): string {
  const bits: string[] = [];
  if (patch.goal) bits.push('goal');
  if (patch.tone || patch.format || patch.budget || patch.deadline || patch.add_must?.length || patch.add_must_not?.length) {
    bits.push('constraints');
  }
  if (patch.add_decisions?.length) bits.push(`${patch.add_decisions.length} decision(s)`);
  if (patch.add_progress?.length) bits.push(`${patch.add_progress.length} progress step(s)`);
  if (patch.open_questions) bits.push('open questions');
  if (patch.next_step) bits.push('next step');
  if (patch.add_glossary?.length) bits.push('glossary');
  if (patch.artifact) bits.push(`output "${patch.artifact.title}"`);
  return bits.length ? `Updated ${bits.join(', ')}` : 'No changes';
}
