import Link from 'next/link';
import { getUser } from '@/lib/supabase/server';
import { CATEGORIES, PROVIDER_LABEL } from '@/lib/chat/types';
import { AppNav } from '@/components/AppNav';

export const metadata = { title: 'Marketplace · AgentHub' };

export default async function MarketplacePage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string }> }) {
  const params = await searchParams;
  // Only letters, numbers, spaces and dashes reach the database filter.
  const q = (params.q ?? '').replace(/[^\p{L}\p{N} -]/gu, '').trim().slice(0, 60);
  const category = CATEGORIES.includes(params.category as (typeof CATEGORIES)[number]) ? params.category : undefined;

  const { supabase, user } = await getUser();
  let query = supabase
    .from('agents')
    .select('slug, name, description, category, kind, provider, creator_id')
    .eq('is_published', true)
    .order('created_at', { ascending: true });
  if (category) query = query.eq('category', category);
  if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
  const { data: agents } = await query;
  // Only show category chips that actually have agents.
  const { data: catRows } = await supabase.from('agents').select('category').eq('is_published', true);
  const usedCategories = CATEGORIES.filter((c) => (catRows ?? []).some((r) => r.category === c));

  return (
    <div className="min-h-dvh bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <AppNav signedIn={Boolean(user)} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-semibold">Agent marketplace</h1>
        <p className="mt-1 text-sm text-zinc-500">Pick an agent to start a task. Switch agents any time — the next one gets a brief of what&apos;s been done.</p>

        <form className="mt-6 flex flex-wrap gap-2" action="/marketplace">
          <input
            name="q"
            defaultValue={q}
            placeholder="Search agents…"
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
          {category && <input type="hidden" name="category" value={category} />}
          <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">Search</button>
        </form>

        <nav className="mt-4 flex flex-wrap gap-2" aria-label="Categories">
          <Link href={q ? `/marketplace?q=${encodeURIComponent(q)}` : '/marketplace'} className={chip(!category)}>All</Link>
          {usedCategories.map((c) => (
            <Link key={c} href={`/marketplace?category=${c}${q ? `&q=${encodeURIComponent(q)}` : ''}`} className={chip(category === c)}>
              {c[0].toUpperCase() + c.slice(1)}
            </Link>
          ))}
        </nav>

        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(agents ?? []).map((a) => (
            <li key={a.slug}>
              <Link
                href={`/marketplace/${a.slug}`}
                className="flex h-full flex-col rounded-xl border border-zinc-200 p-4 transition hover:border-zinc-400 hover:shadow-sm dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <span className="font-medium">{a.name}</span>
                <span className="mt-1 flex-1 text-sm text-zinc-500">{a.description}</span>
                <span className="mt-3 flex flex-wrap gap-1.5 text-xs">
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{a.category}</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                    {a.kind === 'external' ? 'Hosted by creator' : PROVIDER_LABEL[a.provider ?? ''] ?? a.provider}
                  </span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{a.creator_id ? 'Community' : 'AgentHub'}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {!agents?.length && (
          <p className="mt-6 text-sm text-zinc-500">
            No agents match{q ? ` “${q}”` : ''}. <Link href="/marketplace" className="underline">Show all agents</Link>
          </p>
        )}
      </main>
    </div>
  );
}

const chip = (active: boolean) =>
  `rounded-full border px-3 py-1 text-xs ${active ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900' : 'border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900'}`;
