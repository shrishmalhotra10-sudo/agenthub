import 'server-only';
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { signBody } from '@/lib/crypto';

/**
 * Agent contract v1 — how AgentHub talks to a creator's own HTTPS endpoint.
 * See docs/AGENT_CONTRACT.md for the creator-facing description.
 */
export type ExternalRequest = {
  contract_version: '1';
  agent_id: string;
  task_id: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Only the Task State fields the user consented to share with this agent. */
  handoff: Record<string, unknown>;
  artifacts: { id: string; title: string; summary: string; version: number; content?: string }[];
  first_turn_after_handoff: boolean;
};

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string().max(20_000) }),
  z.object({ type: z.literal('artifact'), title: z.string().max(120), content: z.string().max(200_000), summary: z.string().max(500).optional() }),
  z.object({ type: z.literal('state_update'), patch: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('need_artifacts'), ids: z.array(z.string().max(64)).max(10) }),
  z.object({ type: z.literal('done') }),
]);
export type ExternalEvent = z.infer<typeof eventSchema>;

// Addresses an endpoint must never resolve to (stops creators pointing us at internal services).
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::1', 128], ['::', 128], ['fc00::', 7], ['fe80::', 10], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['2002::', 16]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

const devLocalAllowed = (url: URL) =>
  process.env.NODE_ENV === 'development' && url.protocol === 'http:' && url.hostname === 'localhost';

/** Returns an error message if this endpoint URL isn't allowed, else null. */
export async function checkEndpoint(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Endpoint must be a valid URL.';
  }
  if (devLocalAllowed(url)) return null;
  if (url.protocol !== 'https:') return 'Endpoint must use https://';
  if (url.username || url.password) return 'Endpoint URL must not contain credentials.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) return 'Endpoint host could not be resolved.';
  for (const a of addresses) {
    if (blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')) return 'Endpoint must be a public internet address.';
  }
  return null;
}

function parseLine(line: string): ExternalEvent | null {
  try {
    const parsed = eventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // ignore malformed lines
  }
}

/** Calls an external agent and yields its events. Throws with a user-safe message on failure. */
export async function* callExternalAgent(endpoint: string, request: ExternalRequest): AsyncGenerator<ExternalEvent> {
  const problem = await checkEndpoint(endpoint);
  if (problem) throw new Error(`This agent's endpoint is not allowed: ${problem}`);

  const body = JSON.stringify(request);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
      'x-agenthub-timestamp': timestamp,
      'x-agenthub-signature': signBody(request.agent_id, timestamp, body),
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {
    throw new Error("Couldn't reach this agent's server.");
  });
  if (!res.ok || !res.body) throw new Error(`This agent's server returned an error (${res.status}).`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 500_000) throw new Error("This agent's reply was too long.");
    buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const event = line ? parseLine(line) : null;
      if (event) yield event;
    }
  }
  const last = buffer.trim() ? parseLine(buffer.trim()) : null;
  if (last) yield last;
}
