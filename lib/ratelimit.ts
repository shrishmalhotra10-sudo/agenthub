import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Checks and records one use in a server-side ledger (usage_events) that users
 * can't read, edit or delete. Limits live in the consume_quota() SQL function:
 * chat 15/min + 300/day, uploads 20/min + 200/day.
 * Returns an error message if over the limit, otherwise null.
 */
export async function consumeQuota(
  supabase: SupabaseClient,
  kind: 'chat' | 'upload',
  agentId?: string,
): Promise<string | null> {
  // agentId adds a per-agent limit (120 calls/min across all users).
  const { data, error } = await supabase.rpc('consume_quota', { p_kind: kind, p_agent_id: agentId ?? null });
  if (error) {
    console.error('[ratelimit]', error);
    return 'Could not check usage limits. Please try again.';
  }
  return (data as string | null) ?? null;
}
