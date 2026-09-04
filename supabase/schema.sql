-- Live Vote — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Project -> SQL Editor -> New query).
-- Safe to re-run at any time, including on top of an older version of this file.

-- 1. Contestants: the persistent list of contestants and their final average scores.
--    sort_order is the admin's running-order / drag-and-drop position.
--    active=false means "eliminated going into Catent" — kept for history,
--    but excluded from the current lineup. Fetching every row (active or not)
--    is exactly the "very first list" the Start Over button restores.
-- avg = the FINAL score (what contestants are ranked on). If both an audience
-- average and a judges' average exist, avg is their average, rounded to the
-- nearest 0.5 with exact ties rounding down — same rule as the audience avg
-- and judges' avg themselves. audience_avg and judge_avg are kept separately
-- so the breakdown can still be shown independently.
create table if not exists public.contestants (
  id            text primary key,
  name          text not null,
  avg           numeric,
  audience_avg  numeric,
  judge_avg     numeric,
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Safe to re-run even if you already created this table before these columns existed.
alter table public.contestants add column if not exists sort_order int not null default 0;
alter table public.contestants add column if not exists active boolean not null default true;
alter table public.contestants add column if not exists audience_avg numeric;
alter table public.contestants add column if not exists judge_avg numeric;

-- 2. App state: a single row holding "what's happening right now" (which
--    contestant is live, current session id, whether voting is open, which
--    round we're on — 1 = Talent, 2 = Catent), plus talent_results, a frozen
--    snapshot of Talent's final standings taken the moment Catent begins, so
--    Talent's results stay visible even after its scores are cleared for the
--    new round.
create table if not exists public.app_state (
  id              int primary key default 1,
  current_id      text,
  session_id      text,
  voting_active   boolean not null default false,
  round           int not null default 1,
  talent_results  jsonb,
  updated_at      timestamptz not null default now(),
  constraint app_state_singleton check (id = 1)
);

alter table public.app_state add column if not exists round int not null default 1;
alter table public.app_state add column if not exists talent_results jsonb;

insert into public.app_state (id, current_id, session_id, voting_active, round)
values (1, null, null, false, 1)
on conflict (id) do nothing;

-- 3. Audience votes: every individual vote cast, written immediately when it
--    comes in. Keeping every vote (rather than only the final average) means
--    that even if the server crashes mid-round, no cast vote is lost — it's
--    already in Supabase.
create table if not exists public.votes (
  session_id  text not null,
  device_id   text not null,
  score       int  not null check (score between 1 and 10),
  updated_at  timestamptz not null default now(),
  primary key (session_id, device_id)
);

create index if not exists votes_session_id_idx on public.votes (session_id);

-- 4. Judge votes: one row per judge slot (1-4) per session. A judge reloading
--    or switching devices overwrites their own slot instead of stacking an
--    extra vote, since the primary key is (session, judge_num) not a device id.
create table if not exists public.judge_votes (
  session_id  text not null,
  judge_num   int  not null check (judge_num between 1 and 4),
  score       int  not null check (score between 1 and 10),
  updated_at  timestamptz not null default now(),
  primary key (session_id, judge_num)
);

create index if not exists judge_votes_session_id_idx on public.judge_votes (session_id);

-- Row Level Security: this app talks to Supabase only from the trusted Node server
-- using the SERVICE ROLE key, which bypasses RLS entirely. We still enable RLS and
-- add no public policies, so these tables are unreachable from any client-side
-- (anon key) requests — defense in depth in case the anon key ever gets used.
alter table public.contestants enable row level security;
alter table public.app_state   enable row level security;
alter table public.votes       enable row level security;
alter table public.judge_votes enable row level security;
