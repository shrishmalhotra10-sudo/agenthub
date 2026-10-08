-- Phase 1: users, agents, conversations, messages, file uploads.
-- Every table has RLS on. Anything without a policy is denied to the browser.

-- ───────────────────────── profiles ─────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  is_creator   boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Create a profile row automatically when someone signs up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1));
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────── agents ─────────────────────────
-- Public-facing info only. Prompts/endpoints live in agent_configs.
create table public.agents (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9-]{3,48}$'),
  creator_id   uuid references auth.users on delete set null, -- null = platform agent
  name         text not null check (char_length(name) between 1 and 60),
  description  text not null default '' check (char_length(description) <= 500),
  category     text not null default 'general' check (char_length(category) <= 40),
  kind         text not null check (kind in ('nocode', 'external')),
  provider     text check (provider in ('openai', 'anthropic', 'google', 'demo')),
  model        text check (char_length(model) <= 80),
  -- Which Task State fields this agent asks for (used in Phase 3).
  manifest     jsonb not null default '{}'::jsonb,
  is_published boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index agents_creator_idx on public.agents (creator_id);
alter table public.agents enable row level security;

create policy "agents: read published or own" on public.agents
  for select to anon, authenticated
  using (is_published or creator_id = (select auth.uid()));
-- Creating/editing agents arrives in Phase 2.

-- System prompt and endpoint: never readable by end users.
-- Only the agent's creator can read their own; the server reads it with the secret key.
create table public.agent_configs (
  agent_id      uuid primary key references public.agents on delete cascade,
  system_prompt text not null default '' check (char_length(system_prompt) <= 20000),
  endpoint_url  text check (endpoint_url is null or endpoint_url ~ '^https://'),
  updated_at    timestamptz not null default now()
);
alter table public.agent_configs enable row level security;

create policy "agent_configs: creator reads own" on public.agent_configs
  for select to authenticated
  using (exists (
    select 1 from public.agents a
    where a.id = agent_id and a.creator_id = (select auth.uid())
  ));

-- ───────────────────────── conversations ─────────────────────────
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  title           text not null default 'New chat' check (char_length(title) <= 120),
  active_agent_id uuid references public.agents on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index conversations_user_updated_idx on public.conversations (user_id, updated_at desc);
create index conversations_active_agent_idx on public.conversations (active_agent_id);
alter table public.conversations enable row level security;

create policy "conversations: read own" on public.conversations
  for select to authenticated using (user_id = (select auth.uid()));
create policy "conversations: insert own" on public.conversations
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "conversations: update own" on public.conversations
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "conversations: delete own" on public.conversations
  for delete to authenticated using (user_id = (select auth.uid()));

-- ───────────────────────── messages ─────────────────────────
create table public.messages (
  conversation_id uuid not null references public.conversations on delete cascade,
  id              text not null check (char_length(id) between 1 and 64),
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  agent_id        uuid references public.agents on delete set null, -- which agent replied
  parts           jsonb not null,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, id)
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index messages_user_created_idx on public.messages (user_id, created_at desc);
create index messages_agent_idx on public.messages (agent_id);
alter table public.messages enable row level security;

create policy "messages: read own" on public.messages
  for select to authenticated using (user_id = (select auth.uid()));
create policy "messages: insert into own conversation" on public.messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );
create policy "messages: delete own" on public.messages
  for delete to authenticated using (user_id = (select auth.uid()));

-- ───────────────────────── files ─────────────────────────
create table public.files (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  conversation_id uuid references public.conversations on delete cascade,
  name            text not null check (char_length(name) between 1 and 200),
  media_type      text not null check (char_length(media_type) <= 100),
  size_bytes      integer not null check (size_bytes between 1 and 10485760),
  storage_path    text not null unique,
  extracted_text  text,
  created_at      timestamptz not null default now()
);
create index files_user_idx on public.files (user_id);
create index files_conversation_idx on public.files (conversation_id);
alter table public.files enable row level security;

create policy "files: read own" on public.files
  for select to authenticated using (user_id = (select auth.uid()));
create policy "files: insert own" on public.files
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and storage_path like (select auth.uid())::text || '/%'
    and (conversation_id is null or exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    ))
  );
create policy "files: delete own" on public.files
  for delete to authenticated using (user_id = (select auth.uid()));

-- ───────────────────────── storage bucket ─────────────────────────
-- Private bucket; each user can only touch objects under "<their user id>/".
insert into storage.buckets (id, name, public, file_size_limit)
values ('uploads', 'uploads', false, 10485760)
on conflict (id) do nothing;

create policy "uploads: read own folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "uploads: write own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "uploads: delete own folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
