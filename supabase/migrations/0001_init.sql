-- LiftDrop schema. Money is integer US cents. lib/db.ts mirrors these tables in memory
-- until the Supabase project exists.

create table shops (
  id text primary key,                 -- 'bakery', 'cafe'
  name text not null,
  fee_bps int not null default 1000,   -- operator commission, 1000 = 10%
  payout_email text                    -- sandbox business account
);

create table items (
  id text primary key,
  shop_id text not null references shops(id),
  name text not null,
  price_cents int not null check (price_cents > 0),
  grams int not null check (grams > 0),
  stock int not null default 0 check (stock >= 0)
);

create table orders (
  id text primary key,                 -- 'o_42'
  location text not null,              -- 'L23-pantry'
  status text not null default 'created' check (status in (
    'created','held','collecting','en_route','at_door',
    'captured','partially_captured','voided','returning','paid_out','failed')),
  total_cents int not null,
  captured_cents int not null default 0,
  paypal_order_id text,
  authorization_id text,
  capture_id text,
  payout_batch_id text,
  customer_message text,
  created_at timestamptz not null default now()
);

-- One compartment per shop per order; holds that shop's items.
create table compartments (
  order_id text not null references orders(id),
  id text not null,                    -- 'A', 'B'
  shop_id text not null references shops(id),
  value_cents int not null,
  expected_g int not null,
  loaded boolean not null default false,
  door_opened boolean not null default false,
  start_g int,
  end_g int,
  primary key (order_id, id)
);

create table order_items (
  order_id text not null references orders(id),
  item_id text not null references items(id),
  compartment_id text not null,
  qty int not null check (qty > 0),
  primary key (order_id, item_id)
);

-- Raw sensor/fake-button events, append only.
create table events (
  id bigint generated always as identity primary key,
  order_id text not null references orders(id),
  type text not null,
  payload jsonb not null default '{}',
  at timestamptz not null default now()
);

-- Every money movement, append only. Console totals are sums over this.
create table ledger (
  id bigint generated always as identity primary key,
  order_id text not null references orders(id),
  shop_id text references shops(id),
  kind text not null check (kind in ('held','captured','voided','fee','paid_out','refunded')),
  amount_cents int not null,
  paypal_ref text,
  at timestamptz not null default now()
);

-- Handoff agent decisions with the facts it saw.
create table decisions (
  id bigint generated always as identity primary key,
  order_id text not null references orders(id),
  facts jsonb not null,
  proposed jsonb not null,             -- what the agent asked for
  applied jsonb not null,              -- what code allowed
  source text not null,                -- 'llm' | 'fallback'
  reason text not null,
  at timestamptz not null default now()
);

create index on events (order_id);
create index on ledger (order_id);
create index on decisions (order_id);

-- ponytail: demo-only access; the server uses the service-role key and the browser only reads.
alter table shops enable row level security;
alter table items enable row level security;
alter table orders enable row level security;
alter table compartments enable row level security;
alter table order_items enable row level security;
alter table events enable row level security;
alter table ledger enable row level security;
alter table decisions enable row level security;
-- Browser (anon) reads live status; only the server (service_role) writes. events stay server-only.
grant select on shops, items, orders, compartments, order_items, ledger, decisions to anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
create policy "public read" on shops for select to anon, authenticated using (true);
create policy "public read" on items for select to anon, authenticated using (true);
create policy "public read" on orders for select to anon, authenticated using (true);
create policy "public read" on compartments for select to anon, authenticated using (true);
create policy "public read" on order_items for select to anon, authenticated using (true);
create policy "public read" on ledger for select to anon, authenticated using (true);
create policy "public read" on decisions for select to anon, authenticated using (true);

alter publication supabase_realtime add table orders, compartments, ledger, decisions;

insert into shops (id, name, fee_bps) values
  ('bakery', 'Crumb Bakery', 1000),
  ('cafe', 'Level G Café', 1000);
insert into items (id, shop_id, name, price_cents, grams, stock) values
  ('croissant', 'bakery', 'Butter croissant', 450, 80, 20),
  ('pain-choc', 'bakery', 'Pain au chocolat', 500, 90, 15),
  ('iced-latte', 'cafe', 'Iced latte', 900, 450, 30),
  ('americano', 'cafe', 'Hot americano', 600, 350, 30);
