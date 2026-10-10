import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-white p-6 text-center text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-zinc-500">That agent or chat doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link href="/marketplace" className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">
        Back to the marketplace
      </Link>
    </main>
  );
}
