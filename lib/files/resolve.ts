import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type AppUIMessage, fileIdFromUrl } from '@/lib/chat/types';

// Budgets that cap what one request can send to a model (cost + memory).
const MAX_TEXT_PER_FILE = 30_000; // characters of one file
const FILES_IN_LAST_N_MESSAGES = 6; // older files/images become a one-line mention
const MAX_IMAGE_BYTES_PER_REQUEST = 8 * 1024 * 1024;
const MAX_TOTAL_CHARS = 150_000; // whole history; oldest messages are dropped first

type FileRow = {
  id: string;
  name: string;
  media_type: string;
  storage_path: string;
  extracted_text: string | null;
};

const attr = (s: string) => s.replace(/["<>&]/g, '_');
// Stop file content from "closing" its own wrapper tag early.
const escapeBody = (s: string) => s.replace(/<\/?attached_file/gi, '[attached_file');

/**
 * Turns saved chat messages into what the model should see:
 * - documents/code → their extracted text, wrapped in <attached_file> tags
 * - recent images → inline image data (read from private storage as the user)
 * - anything else (reasoning, unknown parts) → dropped
 * Files are looked up with the user's own client, so RLS guarantees they can
 * only ever pull in their own files.
 */
export async function prepareForModel(
  supabase: SupabaseClient,
  messages: AppUIMessage[],
): Promise<AppUIMessage[]> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'file') {
        const id = fileIdFromUrl(p.url);
        if (id) ids.add(id);
      }
    }
  }

  const byId = new Map<string, FileRow>();
  if (ids.size) {
    const { data } = await supabase
      .from('files')
      .select('id, name, media_type, storage_path, extracted_text')
      .in('id', [...ids]);
    for (const row of (data ?? []) as FileRow[]) byId.set(row.id, row);
  }

  const recentFrom = messages.length - FILES_IN_LAST_N_MESSAGES;
  let imageBytes = 0;
  const out: AppUIMessage[] = [];

  for (const [index, message] of messages.entries()) {
    const parts: AppUIMessage['parts'] = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part.type !== 'file') continue;

      const id = fileIdFromUrl(part.url);
      const row = id ? byId.get(id) : undefined;
      if (!row) {
        parts.push({ type: 'text', text: '[an attached file is no longer available]' });
        continue;
      }

      if (index < recentFrom) {
        parts.push({ type: 'text', text: `[file "${attr(row.name)}" was attached earlier]` });
        continue;
      }

      if (row.media_type.startsWith('image/')) {
        const { data: blob } = await supabase.storage.from('uploads').download(row.storage_path);
        if (blob && imageBytes + blob.size <= MAX_IMAGE_BYTES_PER_REQUEST) {
          imageBytes += blob.size;
          const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
          parts.push({
            type: 'file',
            mediaType: row.media_type,
            filename: row.name,
            url: `data:${row.media_type};base64,${base64}`,
          });
        } else {
          parts.push({ type: 'text', text: `[image "${attr(row.name)}" omitted: too large for this request]` });
        }
        continue;
      }

      let body = row.extracted_text ?? '(no readable text could be extracted from this file)';
      if (body.length > MAX_TEXT_PER_FILE) {
        body = body.slice(0, MAX_TEXT_PER_FILE) + '\n…[truncated]';
      }
      parts.push({
        type: 'text',
        text: `<attached_file name="${attr(row.name)}">\n${escapeBody(body)}\n</attached_file>`,
      });
    }
    if (parts.length) out.push({ ...message, parts });
  }

  // Drop the oldest messages until the text fits the budget (always keep the newest).
  const size = (m: AppUIMessage) =>
    m.parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0);
  let total = out.reduce((n, m) => n + size(m), 0);
  while (out.length > 1 && total > MAX_TOTAL_CHARS) total -= size(out.shift()!);
  // Most providers require the conversation to start with a user turn.
  while (out.length > 1 && out[0].role !== 'user') out.shift();

  return out;
}
