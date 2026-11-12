-- Live fleet heartbeats, one row per robot (today: per sim tab). In a table, not server memory,
-- so the API can run as serverless functions (Vercel) where instances don't share memory.
create table robots (
  session text primary key,
  n bigint generated always as identity,   -- LD-01, LD-02, ... in the order robots first reported
  beat jsonb not null,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);
create index robots_last_at on robots (last_at);
alter table robots enable row level security; -- server-only (service role); no public policies
