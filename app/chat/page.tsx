import Link from 'next/link';
import { createConversation } from './actions';
import { SubmitButton } from '@/components/SubmitButton';

export default function ChatHome() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">One chat, many agents</h1>
      <p className="max-w-md text-sm text-zinc-500">
        Start a task with one agent, then switch to another mid-conversation. Each agent sees what
        came before.
      </p>
      <form action={createConversation}>
        <SubmitButton pendingText="Starting…" className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">
          Start a new chat
        </SubmitButton>
      </form>
      <Link href="/marketplace" className="text-sm text-zinc-500 hover:underline">or browse the marketplace →</Link>
    </div>
  );
}
