import 'server-only';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

function masterKey(): Buffer {
  const raw = process.env.AGENTHUB_ENCRYPTION_KEY;
  if (!raw) throw new Error('AGENTHUB_ENCRYPTION_KEY is not set in .env.local');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('AGENTHUB_ENCRYPTION_KEY must be 32 bytes (base64)');
  return key;
}

/** Encrypts a creator's API key (AES-256-GCM). Output: "v1.<iv>.<tag>.<ciphertext>" in base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decryptSecret(encoded: string): string {
  const [version, iv, tag, data] = encoded.split('.');
  if (version !== 'v1') throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function signingMasterKey(): Buffer {
  const raw = process.env.AGENTHUB_SIGNING_KEY;
  if (!raw) throw new Error('AGENTHUB_SIGNING_KEY is not set in .env.local');
  return Buffer.from(raw, 'base64');
}

/** Per-agent secret external agents use to verify requests really come from AgentHub. */
export function signingSecretFor(agentId: string): string {
  return createHmac('sha256', signingMasterKey()).update(`agent-signing:${agentId}`).digest('hex');
}

/** Opaque task id per (conversation, agent): two creators can't link the same user's task. */
export function opaqueTaskId(conversationId: string, agentId: string): string {
  return createHmac('sha256', signingMasterKey()).update(`task:${conversationId}:${agentId}`).digest('hex').slice(0, 32);
}

/** Signature header value for a request body: hex HMAC-SHA256 of "<timestamp>.<body>". */
export function signBody(agentId: string, timestamp: string, body: string): string {
  return createHmac('sha256', signingSecretFor(agentId)).update(`${timestamp}.${body}`).digest('hex');
}
