import { timingSafeEqual } from 'node:crypto';
import { signBody } from '@/lib/crypto';

export const runtime = 'nodejs';

/**
 * A sample EXTERNAL agent that follows the AgentHub agent contract (docs/AGENT_CONTRACT.md).
 * It lives in this app only for the demo; a real creator would host this on their own server.
 * It verifies the request signature, then replies with exactly what context it received.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV !== 'development') return new Response('Not found', { status: 404 });

  const body = await req.text();
  const timestamp = req.headers.get('x-agenthub-timestamp') ?? '';
  const signature = req.headers.get('x-agenthub-signature') ?? '';
  let payload: {
    agent_id: string;
    messages: { role: string; content: string }[];
    handoff: Record<string, unknown>;
    artifacts: { id: string; title: string; summary: string; version: number }[];
    first_turn_after_handoff: boolean;
  };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  // 1) Verify it's really AgentHub calling (and not a replay older than 5 minutes).
  const expected = Buffer.from(signBody(payload.agent_id, timestamp, body));
  const given = Buffer.from(signature);
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  if (!fresh || expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return new Response('Invalid signature', { status: 401 });
  }

  // 2) Reply as NDJSON events.
  const h = payload.handoff as {
    goal?: string;
    decisions?: { what: string; why: string; by: string }[];
    progress?: { step: string; outcome: string }[];
    constraints?: { must?: string[]; must_not?: string[]; tone?: string };
  };
  const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const lines = [
    payload.first_turn_after_handoff ? '**Picking up from the previous agent** — here is exactly what AgentHub sent me:\n' : '**Here is what AgentHub sent me:**\n',
    `- Goal: ${h.goal || '(not shared)'}`,
    `- Decisions: ${h.decisions?.length ? h.decisions.map((d) => `${d.what}${d.why ? ` (because ${d.why})` : ''}`).join('; ') : '(none or not shared)'}`,
    `- Progress: ${h.progress?.length ? h.progress.map((p) => p.step).join('; ') : '(none or not shared)'}`,
    `- Constraints: ${h.constraints ? [h.constraints.tone, ...(h.constraints.must ?? []), ...(h.constraints.must_not ?? []).map((m) => `not: ${m}`)].filter(Boolean).join('; ') || '(none)' : '(not shared)'}`,
    `- Files & outputs: ${payload.artifacts.length ? payload.artifacts.map((a) => `${a.title} v${a.version}`).join(', ') : '(none or not shared)'}`,
    `- Messages since I took over: ${payload.messages.length}`,
    '',
    `Your latest message: "${lastUser.slice(0, 200)}"`,
    '',
    '_This is the sample external agent. A real one would do the work here._',
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'text', delta: line + '\n' }) + '\n'));
        await new Promise((r) => setTimeout(r, 40));
      }
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
}
