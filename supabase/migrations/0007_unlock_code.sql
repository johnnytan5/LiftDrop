-- The 4-digit code the customer types on the robot's screen to open its compartments. Its own
-- table so no order read (consoles, /api/state, /ops) can ever return it; RLS on, no policies:
-- only the server's service-role key reads it.
create table order_secrets (
  order_id text primary key references orders(id) on delete cascade,
  code text not null check (code ~ '^[0-9]{4}$'),
  tries int not null default 0,
  unlocked_at timestamptz
);
alter table order_secrets enable row level security;
