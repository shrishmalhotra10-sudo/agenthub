import Link from 'next/link';

/** Top bar for the marketplace and creator pages. */
export function AppNav({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3 text-sm">
        <Link href="/marketplace" className="font-semibold">AgentHub</Link>
        <nav className="flex flex-1 gap-4 text-zinc-600 dark:text-zinc-400">
          <Link href="/marketplace" className="hover:text-zinc-900 dark:hover:text-white">Marketplace</Link>
          {signedIn && <Link href="/chat" className="hover:text-zinc-900 dark:hover:text-white">My chats</Link>}
          {signedIn && <Link href="/creator" className="hover:text-zinc-900 dark:hover:text-white">Creator</Link>}
        </nav>
        {!signedIn && (
          <Link href="/login" className="rounded-lg bg-zinc-900 px-3 py-1.5 font-medium text-white dark:bg-white dark:text-zinc-900">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
