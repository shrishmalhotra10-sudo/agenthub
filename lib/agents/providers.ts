import 'server-only';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { simulateReadableStream, type LanguageModel } from 'ai';

const KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

/** True if this provider has an API key configured on the server. */
export function isProviderLive(provider: string | null): boolean {
  const envName = provider ? KEY_ENV[provider] : undefined;
  return Boolean(envName && process.env[envName]);
}

/**
 * Returns a real model for the provider, or null if no key is available.
 * `apiKey` = a creator's own (decrypted) key; without it, platform agents use our env keys.
 *
 * Base URLs are pinned on purpose: the SDKs otherwise read OPENAI_BASE_URL /
 * ANTHROPIC_BASE_URL from the environment, which could silently send API keys
 * to a non-provider host.
 */
export function getModel(provider: string | null, model: string | null, apiKey?: string | null): LanguageModel | null {
  if (!provider || !model) return null;
  const key = apiKey ?? (KEY_ENV[provider] ? process.env[KEY_ENV[provider]] : undefined);
  if (!key) return null;
  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey: key, baseURL: 'https://api.openai.com/v1' })(model);
    case 'anthropic':
      return createAnthropic({ apiKey: key, baseURL: 'https://api.anthropic.com/v1' })(model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: key, baseURL: 'https://generativelanguage.googleapis.com/v1beta' })(model);
    default:
      return null;
  }
}

/**
 * A free stand-in model that streams a fixed reply. Used when a provider key
 * is missing, so the whole app can be clicked through without paying.
 */
export async function createDemoModel(reply: string): Promise<LanguageModel> {
  // Loaded only when needed, so the test helper isn't part of normal requests.
  const { MockLanguageModelV4 } = await import('ai/test');
  const words = reply.split(/(?<=\s)/);
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: 15,
        chunks: [
          { type: 'text-start', id: 't1' },
          ...words.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: words.length, text: words.length, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}
