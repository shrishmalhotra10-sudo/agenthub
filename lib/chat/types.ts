import type { UIMessage } from 'ai';
import type { ShareableField } from '@/lib/taskstate/fields';

/** Extra info attached to each chat message. */
export type MessageMetadata = {
  /** Which agent wrote this reply (assistant messages only). */
  agentId?: string;
};

export type AppUIMessage = UIMessage<MessageMetadata>;

/** Agent info that is safe to send to the browser (no prompts, no keys). */
export type PublicAgent = {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: 'nocode' | 'external';
  provider: string | null;
  model: string | null;
  /** Task State fields this agent asks for in its manifest. */
  needs: ShareableField[];
  /** Made by a community creator (not AgentHub). */
  byCreator: boolean;
  /** False when the provider's API key isn't configured, so the demo model answers instead. */
  live: boolean;
};

/** Uploaded files are referenced in messages by this app-internal URL only. */
export const FILE_URL_RE = /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function fileIdFromUrl(url: string): string | null {
  return FILE_URL_RE.exec(url)?.[1] ?? null;
}

export const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Gemini',
  demo: 'Demo',
};

export const CATEGORIES = ['research', 'writing', 'editing', 'career', 'design', 'coding', 'business', 'developer', 'general'] as const;
