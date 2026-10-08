import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/supabase/server';
import { createConversation, signOut } from './actions';

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const { supabase, user } = await getUser();
  if (!user) redirect('/login');

  const { data: conversations } = await supabase
    .from('conversations')
    .select('id, title')
    .order('updated_at', { ascending: false })
    .limit(50);

  return (
    <div className="flex h-dvh bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between p-3">
          <Link href="/marketplace" className="font-semibold">AgentHub</Link>
          <form action={createConversation}>
            <button className="rounded-lg border border-zinc-300 px-2.5 py-1 text-sm hover:bg-white dark:border-zinc-700 dark:hover:bg-zinc-800">
              + New chat
            </button>
          </form>
        </div>
        <div className="flex gap-3 px-3 pb-2 text-sm text-zinc-600 dark:text-zinc-400">
          <Link href="/marketplace" className="hover:underline">Marketplace</Link>
          <Link href="/creator" className="hover:underline">Creator</Link>
        </div>
        <nav className="flex-1 overflow-y-auto px-2" aria-label="Conversations">
          {(conversations ?? []).map((c) => (
            <Link
              key={c.id}
              href={`/chat/${c.id}`}
              className="block truncate rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {c.title}
            </Link>
          ))}
          {!conversations?.length && <p className="px-2 py-1.5 text-sm text-zinc-500">No chats yet.</p>}
        </nav>
        <div className="border-t border-zinc-200 p-3 text-xs text-zinc-500 dark:border-zinc-800">
          <p className="truncate">{user.email}</p>
          <form action={signOut}>
            <button className="mt-1 hover:underline">Sign out</button>
          </form>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
