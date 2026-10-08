-- Phase 2 (agent hosting + marketplace) and Phase 3 (Task State handoff layer).

-- ───────────── Phase 2: creators manage their own agents ─────────────
create policy "agents: creator inserts own" on public.agents
  for insert to authenticated with check (creator_id = (select auth.uid()));
create policy "agents: creator updates own" on public.agents
  for update to authenticated
  using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));
create policy "agents: creator deletes own" on public.agents
  for delete to authenticated using (creator_id = (select auth.uid()));

create policy "agent_configs: creator inserts own" on public.agent_configs
  for insert to authenticated
  with check (exists (select 1 from public.agents a where a.id = agent_id and a.creator_id = (select auth.uid())));
create policy "agent_configs: creator updates own" on public.agent_configs
  for update to authenticated
  using (exists (select 1 from public.agents a where a.id = agent_id and a.creator_id = (select auth.uid())))
  with check (exists (select 1 from public.agents a where a.id = agent_id and a.creator_id = (select auth.uid())));

-- Allow http://localhost endpoints too (the app only calls them in development).
alter table public.agent_configs drop constraint agent_configs_endpoint_url_check;
alter table public.agent_configs add constraint agent_configs_endpoint_url_check
  check (endpoint_url is null or endpoint_url ~ '^(https://|http://localhost(:[0-9]+)?/)');

-- Creators' provider API keys, encrypted by the server. No policies: browser can't touch it.
create table public.agent_secrets (
  agent_id          uuid primary key references public.agents on delete cascade,
  api_key_encrypted text not null,
  updated_at        timestamptz not null default now()
);
alter table public.agent_secrets enable row level security;

-- Per-agent limit on top of the per-user limit, so one agent can't be hammered.
alter table public.usage_events add column agent_id uuid references public.agents on delete cascade;
create index usage_events_agent_created_idx on public.usage_events (agent_id, created_at desc);

drop function public.consume_quota(text);
create function public.consume_quota(p_kind text, p_agent_id uuid default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  per_minute int;
  per_day int;
  used_minute int;
  used_day int;
  agent_minute int;
begin
  if uid is null then return 'Not signed in.'; end if;
  if p_kind = 'chat' then per_minute := 15; per_day := 300;
  elsif p_kind = 'upload' then per_minute := 20; per_day := 200;
  else return 'Unknown usage type.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(uid::text || p_kind, 0));

  select count(*) filter (where created_at > now() - interval '1 minute'), count(*)
    into used_minute, used_day
    from public.usage_events
   where user_id = uid and kind = p_kind and created_at > now() - interval '1 day';

  if used_minute >= per_minute then
    return format('You''ve hit the limit of %s %s per minute. Please wait a bit.', per_minute,
                  case p_kind when 'chat' then 'messages' else 'uploads' end);
  end if;
  if used_day >= per_day then
    return format('You''ve hit the daily limit of %s %s. Try again tomorrow.', per_day,
                  case p_kind when 'chat' then 'messages' else 'uploads' end);
  end if;

  if p_agent_id is not null then
    select count(*) into agent_minute from public.usage_events
     where agent_id = p_agent_id and created_at > now() - interval '1 minute';
    if agent_minute >= 120 then
      return 'This agent is very busy right now. Please try again in a minute.';
    end if;
  end if;

  insert into public.usage_events (user_id, kind, agent_id) values (uid, p_kind, p_agent_id);
  return null;
end;
$$;
revoke execute on function public.consume_quota(text, uuid) from public, anon;
grant execute on function public.consume_quota(text, uuid) to authenticated;

-- ───────────── Phase 3: Task State (one per conversation, owned by the user) ─────────────
create table public.task_states (
  conversation_id uuid primary key references public.conversations on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  state           jsonb not null default '{}'::jsonb,
  version         integer not null default 1,
  updated_at      timestamptz not null default now()
);
create index task_states_user_idx on public.task_states (user_id);
alter table public.task_states enable row level security;
create policy "task_states: read own" on public.task_states
  for select to authenticated using (user_id = (select auth.uid()));
create policy "task_states: insert own" on public.task_states
  for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));
create policy "task_states: update own" on public.task_states
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- History of every change to the Task State, and agent proposals awaiting approval.
create table public.task_state_changes (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  source          text not null check (source in ('extractor', 'user', 'agent')),
  agent_id        uuid references public.agents on delete set null,
  summary         text not null default '' check (char_length(summary) <= 300),
  patch           jsonb not null,
  status          text not null check (status in ('applied', 'pending', 'rejected')),
  created_at      timestamptz not null default now()
);
create index task_state_changes_conv_idx on public.task_state_changes (conversation_id, created_at desc);
create index task_state_changes_user_idx on public.task_state_changes (user_id);
create index task_state_changes_agent_idx on public.task_state_changes (agent_id);
alter table public.task_state_changes enable row level security;
create policy "task_state_changes: read own" on public.task_state_changes
  for select to authenticated using (user_id = (select auth.uid()));
create policy "task_state_changes: insert own" on public.task_state_changes
  for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));
create policy "task_state_changes: update own" on public.task_state_changes
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Versioned outputs (e.g. "Resume v2"). Agents get title + summary; full content on request.
create table public.artifacts (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations on delete cascade,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  title             text not null check (char_length(title) between 1 and 120),
  summary           text not null default '' check (char_length(summary) <= 500),
  content           text not null check (char_length(content) <= 200000),
  version           integer not null default 1,
  agent_id          uuid references public.agents on delete set null,
  source_message_id text,
  created_at        timestamptz not null default now()
);
create index artifacts_conv_idx on public.artifacts (conversation_id, created_at desc);
create index artifacts_user_idx on public.artifacts (user_id);
create index artifacts_agent_idx on public.artifacts (agent_id);
alter table public.artifacts enable row level security;
create policy "artifacts: read own" on public.artifacts
  for select to authenticated using (user_id = (select auth.uid()));
create policy "artifacts: insert own" on public.artifacts
  for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));

-- What each agent may see of this task. Revocable.
create table public.consents (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users on delete cascade,
  agent_id        uuid not null references public.agents on delete cascade,
  fields          text[] not null,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);
create index consents_conv_agent_idx on public.consents (conversation_id, agent_id, created_at desc);
create index consents_user_idx on public.consents (user_id);
create index consents_agent_idx on public.consents (agent_id);
alter table public.consents enable row level security;
create policy "consents: read own" on public.consents
  for select to authenticated using (user_id = (select auth.uid()));
create policy "consents: insert own" on public.consents
  for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));
create policy "consents: update own" on public.consents
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Audit log: every time Task State data is sent to an agent. Written only by the server.
create table public.share_log (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations on delete cascade,
  user_id         uuid not null references auth.users on delete cascade,
  agent_id        uuid references public.agents on delete set null,
  fields          text[] not null,
  state_version   integer not null,
  created_at      timestamptz not null default now()
);
create index share_log_conv_idx on public.share_log (conversation_id, created_at desc);
create index share_log_user_idx on public.share_log (user_id);
create index share_log_agent_idx on public.share_log (agent_id);
alter table public.share_log enable row level security;
create policy "share_log: read own" on public.share_log
  for select to authenticated using (user_id = (select auth.uid()));

-- Security review fix: only agents the caller may use count toward an agent's budget.
-- (Applied as migration "quota_agent_visibility"; same body as above plus this check.)
-- if p_agent_id is not null and not exists (select 1 from public.agents a
--   where a.id = p_agent_id and (a.is_published or a.creator_id = uid)) then return 'That agent is not available.'; end if;
