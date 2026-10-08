import { getUser } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/** Streams one of the user's own uploaded files. RLS blocks everyone else's. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, user } = await getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { data: file } = await supabase
    .from('files')
    .select('name, media_type, storage_path')
    .eq('id', id)
    .maybeSingle();
  if (!file) return new Response('Not found', { status: 404 });

  const { data: blob } = await supabase.storage.from('uploads').download(file.storage_path);
  if (!blob) return new Response('Not found', { status: 404 });

  // Images display inline; everything else downloads (never rendered as a web page).
  const isImage = file.media_type.startsWith('image/');
  const safeName = encodeURIComponent(file.name);
  return new Response(blob, {
    headers: {
      'Content-Type': isImage ? file.media_type : 'application/octet-stream',
      'Content-Disposition': `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
