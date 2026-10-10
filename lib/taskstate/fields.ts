// Field names and labels, kept free of zod so browser components can import them cheaply.

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
