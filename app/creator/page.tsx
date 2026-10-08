import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/supabase/server';
import { PROVIDER_LABEL } from '@/lib/chat/types';
import { AppNav } from '@/components/AppNav';

export const metadata = { title: 'Creator dashboard · AgentHub' };

export default async function CreatorPage() {
  const { supabase, user } = await getUser();
  if (!user) redirect('/login');

  const { data: agents } = await supabase
    .from('agents')
    .select('id, slug, name, kind, provider, model, is_published, updated_at')
    .eq('creator_id', user.id)
    .order('updated_at', { ascending: false });

  return (
    <div className="min-h-dvh bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <AppNav signedIn />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Your agents</h1>
            <p className="text-sm text-zinc-500">Publish agents to the marketplace. You never see users&apos; chats — your agent only gets what each user agrees to share.</p>
          </div>
          <Link href="/creator/new" className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">
            + New agent
          </Link>
        </div>

        <ul className="mt-6 divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {(agents ?? []).map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="font-medium">{a.name}</p>
                <p className="text-xs text-zinc-500">
                  {a.kind === 'external' ? 'Your own server' : `${PROVIDER_LABEL[a.provider ?? ''] ?? a.provider} · ${a.model}`} ·{' '}
                  {a.is_published ? <span className="text-emerald-600">Published</span> : 'Draft'}
                </p>
              </div>
              <div className="flex shrink-0 gap-3 text-sm">
                {a.is_published && <Link href={`/marketplace/${a.slug}`} className="text-zinc-500 hover:underline">View</Link>}
                <Link href={`/creator/${a.id}`} className="hover:underline">Edit</Link>
              </div>
            </li>
          ))}
          {!agents?.length && <li className="p-6 text-center text-sm text-zinc-500">No agents yet. Create your first one.</li>}
        </ul>
      </main>
    </div>
  );
}
