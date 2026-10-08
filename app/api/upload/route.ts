import { getUser } from '@/lib/supabase/server';
import { classify, contentMatches, extractText, MAX_FILE_BYTES } from '@/lib/files/extract';
import { consumeQuota } from '@/lib/ratelimit';
import { applyAndRecord } from '@/lib/taskstate/store';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (message: string, status: number) => new Response(message, { status });

/** Upload one file → private storage + text extraction. Returns a reference to put in a message. */
export async function POST(req: Request) {
  const { supabase, user } = await getUser();
  if (!user) return text('Please sign in again.', 401);

  // Refuse oversized uploads before reading the body into memory.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_FILE_BYTES + 64 * 1024) return text('Files must be 10 MB or smaller.', 413);

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  const conversationId = form?.get('conversationId');
  if (!(file instanceof File)) return text('No file received.', 400);
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
    return text('Missing conversation.', 400);
  }
  if (file.size === 0) return text('That file is empty.', 400);
  if (file.size > MAX_FILE_BYTES) return text('Files must be 10 MB or smaller.', 413);

  const name = file.name.replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
  const type = classify(name);
  if (!type) return text('Unsupported file type. Use PDF, DOCX, images, or text/code files.', 415);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!contentMatches(type.kind, type.mediaType, bytes)) {
    return text("That file's contents don't match its extension.", 415);
  }

  const limited = await consumeQuota(supabase, 'upload');
  if (limited) return text(limited, 429);

  // RLS: only finds the conversation if it's the user's own.
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversation) return text('Conversation not found.', 404);

  const ext = name.toLowerCase().split('.').pop();
  const storagePath = `${user.id}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from('uploads')
    .upload(storagePath, bytes, { contentType: type.mediaType, upsert: false });
  if (uploadError) {
    console.error('[upload] storage', uploadError);
    return text('Upload failed. Please try again.', 500);
  }

  const extracted = await extractText(type.kind, bytes);

  const { data: row, error } = await supabase
    .from('files')
    .insert({
      user_id: user.id,
      conversation_id: conversationId,
      name,
      media_type: type.mediaType,
      size_bytes: file.size,
      storage_path: storagePath,
      extracted_text: extracted,
    })
    .select('id')
    .single();
  if (error || !row) {
    console.error('[upload] insert', error);
    await supabase.storage.from('uploads').remove([storagePath]);
    return text('Upload failed. Please try again.', 500);
  }

  // Readable uploads are also listed in the Task State, so the next agent knows they exist
  // (title + summary; full text only via read_artifact, and only if the user shares outputs).
  if (extracted) {
    const { data: artifact } = await supabase
      .from('artifacts')
      .insert({
        conversation_id: conversationId,
        user_id: user.id,
        title: name.slice(0, 120),
        summary: `Uploaded by the user (${type.kind.toUpperCase()}, ${extracted.length.toLocaleString()} characters).`,
        content: extracted,
      })
      .select('id')
      .single();
    if (artifact) {
      await applyAndRecord(supabase, {
        conversationId,
        userId: user.id,
        patch: {},
        by: 'user',
        source: 'user',
        mutate: (state) => ({
          ...state,
          artifacts: [
            ...state.artifacts,
            { id: artifact.id, title: name.slice(0, 120), summary: 'File uploaded by the user.', version: 1, by: 'user' },
          ],
        }),
      });
    }
  }

  return Response.json({
    id: row.id,
    name,
    mediaType: type.mediaType,
    url: `/api/files/${row.id}`,
    readable: type.kind === 'image' || extracted !== null,
  });
}
