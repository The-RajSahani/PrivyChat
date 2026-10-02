-- PrivyChat schema. Run once in Supabase: SQL Editor -> New query -> paste -> Run.

create extension if not exists pgcrypto;

-- ROOMS -----------------------------------------------------------------
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  room_code   text not null unique check (room_code ~ '^[A-Z0-9]{6}$'),
  created_at  timestamptz not null default now()
);

-- MEMBERS: each member owns a password hash. There is no room password. ---
create table if not exists public.members (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms(id) on delete cascade,
  username       text not null check (char_length(username) between 3 and 24),
  password_hash  text not null,
  created_at     timestamptz not null default now()
);
-- Username unique per room (case-insensitive). Other rooms may reuse it.
create unique index if not exists members_room_username_uniq
  on public.members (room_id, lower(username));
create index if not exists members_room_id_idx on public.members (room_id);

-- MESSAGES --------------------------------------------------------------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  member_id   uuid not null references public.members(id) on delete cascade,
  message     text not null check (char_length(message) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);
create index if not exists messages_room_id_idx      on public.messages (room_id);
create index if not exists messages_member_id_idx    on public.messages (member_id);
create index if not exists messages_created_at_idx   on public.messages (created_at);

-- SESSIONS: server-side sessions so logout truly invalidates access -------
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.members(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_member_id_idx  on public.sessions (member_id);
create index if not exists sessions_expires_at_idx on public.sessions (expires_at);

-- ROW LEVEL SECURITY ----------------------------------------------------
-- The Express API uses the service-role key, which bypasses RLS.
-- Browsers only ever hold the anon key + a short-lived room token.
alter table public.rooms    enable row level security;
alter table public.members  enable row level security;
alter table public.messages enable row level security;
alter table public.sessions enable row level security;

revoke all on public.rooms, public.members, public.messages, public.sessions from anon, authenticated;

-- The only thing a browser may do: SELECT messages of the room named in its signed token
-- (needed so Realtime can deliver new messages). password_hash lives in `members`,
-- which browsers cannot read at all.
grant select on public.messages to authenticated;
drop policy if exists "room token can read own room messages" on public.messages;
create policy "room token can read own room messages"
  on public.messages for select to authenticated
  using (room_id = nullif(auth.jwt() ->> 'room_id', '')::uuid);

-- REALTIME --------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;


-- REALTIME PRESENCE AUTHORIZATION --------------------------------------
-- The browser uses a short-lived custom JWT containing room_id.
-- Private Realtime channels prevent other users from joining a room's
-- presence channel without being authenticated for that room.
-- Do NOT add ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY here;
-- Supabase already enables RLS on this managed table.

drop policy if exists "privychat presence read" on realtime.messages;
create policy "privychat presence read"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and split_part(realtime.topic(), ':', 1) = 'room'
    and split_part(realtime.topic(), ':', 2) = (select auth.jwt() ->> 'room_id')
  );

drop policy if exists "privychat presence write" on realtime.messages;
create policy "privychat presence write"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and split_part(realtime.topic(), ':', 1) = 'room'
    and split_part(realtime.topic(), ':', 2) = (select auth.jwt() ->> 'room_id')
  );
