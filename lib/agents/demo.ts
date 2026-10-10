import 'server-only';
import { PROVIDER_LABEL } from '@/lib/chat/types';
import { clean } from '@/lib/taskstate/render';
import type { ShareableField, TaskState } from '@/lib/taskstate/schema';

/**
 * Replies used when an agent has no AI key configured ("demo mode").
 * They are templates, clearly labelled as such, but they exercise the real
 * handoff machinery: the job-application demo only uses what the user shared.
 */

type DemoInput = {
  agentSlug: string;
  agentName: string;
  provider: string | null;
  userText: string;
  previousAgentName: string | null;
  state: TaskState;
  fields: ShareableField[];
};

/** The automatic message sent on handoff is "Handing off to X." plus an optional "Next: …". */
export function stripHandoffPrefix(text: string): string {
  const match = /^Handing off to [^.]+\.\s*(?:Next:\s*)?/i.exec(text);
  return match ? text.slice(match[0].length).trim() : text;
}

const sentences = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);

export function demoReply(o: DemoInput): string {
  const ask = stripHandoffPrefix(o.userText);
  const providerName = PROVIDER_LABEL[o.provider ?? ''] ?? 'this provider';
  const footer = `_Demo mode — no ${providerName} API key is set, so ${o.agentName} answered with a template built from your messages and the handoff brief. Add a key for real answers._`;
  const header = o.previousAgentName ? handoffConfirmation(o, ask) : '';

  let body: string;
  if (o.agentSlug === 'resume-builder') body = resumeDraft(ask || o.state.goal);
  else if (o.agentSlug === 'job-application-assistant') body = coverLetterDraft(o, ask);
  else body = genericReply(o, ask);

  return [header, body, footer].filter(Boolean).join('\n\n');
}

function handoffConfirmation(o: DemoInput, ask: string): string {
  const has = (f: ShareableField) => o.fields.includes(f);
  if (!o.fields.length) {
    return `**Picking up from ${o.previousAgentName}.** You didn't share the task brief with me, so I only know what you tell me from here.`;
  }
  const done = has('artifacts') && o.state.artifacts.length
    ? `${o.state.artifacts.at(-1)!.title} is ready`
    : has('progress') && o.state.progress.length
      ? clean(o.state.progress.at(-1)!.outcome || o.state.progress.at(-1)!.step, 100)
      : 'the earlier work';
  const next = ask || (has('open_questions') && o.state.next_step) || 'continue the task';
  return `**Picking up from ${o.previousAgentName}** (${done}), next I'll ${clean(next, 140).replace(/^[A-Z]/, (c) => c.toLowerCase()).replace(/\.+$/, '')}.`;
}

function resumeDraft(source: string): string {
  const facts = sentences(clean(source, 1200)).filter((s) => !/^(build|make|create|write|help)\b/i.test(s));
  const bullets = facts.length ? facts.map((s) => `- ${s.replace(/\.$/, '')}`) : ['- (Tell me your roles, dates and key achievements)'];
  return [
    "Here's a first draft based on what you told me.",
    '',
    '# Resume — first draft',
    '',
    '## Summary',
    facts[0] ? `Results-driven professional. ${facts[0]}` : 'Results-driven professional.',
    '',
    '## Experience highlights',
    ...bullets,
    '',
    '## Skills',
    '- Strategy & roadmapping · Stakeholder management · Data-driven decisions · Cross-functional leadership',
    '',
    '**Key choices I made:**',
    '- **Decision:** Lead with measurable impact (launches, revenue) — because hiring managers for senior roles skim for outcomes.',
    '- **Decision:** Keep it to one page — because the target companies are fast-moving startups.',
  ].join('\n');
}

function coverLetterDraft(o: DemoInput, ask: string): string {
  const has = (f: ShareableField) => o.fields.includes(f);
  const goal = has('goal') ? clean(o.state.goal, 300) : '';
  const decisions = has('decisions') ? o.state.decisions : [];
  const resume = has('artifacts') ? o.state.artifacts.filter((a) => a.by !== 'user').at(-1) ?? o.state.artifacts.at(-1) : undefined;
  const role = /\bfor (?:the )?(.+)$/i.exec(ask)?.[1]?.replace(/\.$/, '');
  // The user's background, from the goal, without the request itself ("Build my resume…").
  const background = sentences(goal).filter((s) => !/^(build|make|create|write|help)\b/i.test(s)).slice(0, 2).join(' ');

  const lines = [
    '# Cover letter — first draft',
    '',
    'Dear Hiring Manager,',
    '',
    `I'm excited to apply for ${role ? `the ${clean(role, 100)}` : 'this role'}.`,
    ...(background ? ['', `A little about me: ${background}`] : []),
  ];
  if (decisions.length) {
    lines.push('', `This letter follows the approach we agreed on: ${decisions.map((d) => clean(d.what, 160).replace(/\.$/, '').replace(/^[A-Z]/, (c) => c.toLowerCase())).join('; ')}.`);
  }
  if (resume) lines.push('', `As my resume ("${clean(resume.title, 80)}") shows, I focus on outcomes rather than activity.`);
  lines.push('', "I'd welcome the chance to talk about how I can help.", '', 'Sincerely,', '[Your name]', '');

  lines.push('**What I used from the handoff brief:**');
  lines.push(`- Goal: ${goal ? '✓' : '✗ not shared'}`);
  lines.push(`- Decisions: ${has('decisions') ? (decisions.length ? `✓ ${decisions.length} kept — ${decisions.map((d) => `"${clean(d.what, 60)}"`).join(', ')}` : '✓ none yet') : '✗ not shared'}`);
  lines.push(`- Resume: ${resume ? `✓ ${clean(resume.title, 60)} v${resume.version}` : has('artifacts') ? '✓ none yet' : '✗ not shared'}`);
  return lines.join('\n');
}

function genericReply(o: DemoInput, ask: string): string {
  const has = (f: ShareableField) => o.fields.includes(f);
  const lines: string[] = [];
  if (ask) lines.push(`You asked: "${clean(ask, 200)}"`);
  if (o.fields.length) {
    lines.push('', 'What I received in the handoff brief:');
    if (has('goal')) lines.push(`- **Goal:** ${clean(o.state.goal, 200) || '—'}`);
    if (has('constraints')) {
      const c = o.state.constraints;
      const items = [c.tone && `tone: ${c.tone}`, c.format && `format: ${c.format}`, c.deadline && `deadline: ${c.deadline}`, ...c.must.map((m) => `must: ${m}`), ...c.must_not.map((m) => `must not: ${m}`)].filter(Boolean);
      lines.push(`- **Constraints:** ${items.length ? clean(items.join('; '), 300) : '—'}`);
    }
    if (has('decisions')) {
      lines.push(`- **Decisions I'll keep:** ${o.state.decisions.length ? o.state.decisions.map((d) => clean(`${d.what}${d.why ? ` (because ${d.why})` : ''}`, 160)).join('; ') : '—'}`);
    }
    if (has('progress')) lines.push(`- **Done so far:** ${o.state.progress.length ? o.state.progress.map((p) => `${clean(p.step, 80)}${p.by ? ` (${clean(p.by, 40)})` : ''}`).join('; ') : '—'}`);
    if (has('artifacts')) lines.push(`- **Files & outputs:** ${o.state.artifacts.length ? o.state.artifacts.map((a) => `${clean(a.title, 80)} v${a.version}`).join(', ') : '—'}`);
  }
  return lines.join('\n');
}
