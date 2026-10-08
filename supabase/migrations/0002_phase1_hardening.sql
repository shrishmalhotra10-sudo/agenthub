-- Fixes from the Phase 1 security review.

-- 1) Users may only edit their display name, never promote themselves to creator.
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;

-- 2) Users can only insert their OWN messages from the browser. Assistant replies
--    are saved by the server (secret key), so nobody can forge an agent's reply.
drop policy "messages: insert into own conversation" on public.messages;
create policy "messages: insert own user message" on public.messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and role = 'user'
    and agent_id is null
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );

-- 3) Only known file types, so nothing (e.g. SVG/HTML) can be served inline.
alter table public.files add constraint files_media_type_allowed check (media_type in (
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain'
));

-- 4) Usage ledger for rate limiting. No RLS policies = invisible and
--    unwritable from the browser; deleting chats/files doesn't reset limits.
create table public.usage_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  kind       text not null check (kind in ('chat', 'upload')),
  created_at timestamptz not null default now()
);
create index usage_events_user_kind_created_idx on public.usage_events (user_id, kind, created_at desc);
alter table public.usage_events enable row level security;

-- Checks limits and records one use, atomically, for the calling user.
-- Returns null if allowed, or a human-readable reason if over the limit.
create function public.consume_quota(p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  per_minute int;
  per_day int;
  used_minute int;
  used_day int;
begin
  if uid is null then return 'Not signed in.'; end if;
  if p_kind = 'chat' then per_minute := 15; per_day := 300;
  elsif p_kind = 'upload' then per_minute := 20; per_day := 200;
  else return 'Unknown usage type.';
  end if;

  -- Serialize concurrent requests from the same user.
  perform pg_advisory_xact_lock(hashtextextended(uid::text || p_kind, 0));

  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*)
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

  insert into public.usage_events (user_id, kind) values (uid, p_kind);
  return null;
end;
$$;
revoke execute on function public.consume_quota(text) from public, anon;
grant execute on function public.consume_quota(text) to authenticated;
