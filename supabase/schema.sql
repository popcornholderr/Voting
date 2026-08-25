-- Live Vote — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Project -> SQL Editor -> New query).

-- 1. Contestants: the persistent list of contestants and their final average scores.
create table if not exists public.contestants (
  id          text primary key,
  name        text not null,
  avg         numeric,
  created_at  timestamptz not null default now()
);

-- 2. App state: a single row holding "what's happening right now"
--    (which contestant is live, current session id, whether voting is open).
create table if not exists public.app_state (
  id              int primary key default 1,
  current_id      text,
  session_id      text,
  voting_active   boolean not null default false,
  updated_at      timestamptz not null default now(),
  constraint app_state_singleton check (id = 1)
);

insert into public.app_state (id, current_id, session_id, voting_active)
values (1, null, null, false)
on conflict (id) do nothing;

-- 3. Votes: every individual vote cast, written immediately when it comes in.
--    Keeping every vote (rather than only the final average) means that even if
--    the server crashes mid-round, no cast vote is lost — it's already in Supabase.
create table if not exists public.votes (
  session_id  text not null,
  device_id   text not null,
  score       int  not null check (score between 1 and 10),
  updated_at  timestamptz not null default now(),
  primary key (session_id, device_id)
);

create index if not exists votes_session_id_idx on public.votes (session_id);

-- Row Level Security: this app talks to Supabase only from the trusted Node server
-- using the SERVICE ROLE key, which bypasses RLS entirely. We still enable RLS and
-- add no public policies, so these tables are unreachable from any client-side
-- (anon key) requests — defense in depth in case the anon key ever gets used.
alter table public.contestants enable row level security;
alter table public.app_state   enable row level security;
alter table public.votes       enable row level security;
