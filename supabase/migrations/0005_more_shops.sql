-- Two more lobby shops. The robot still carries from at most two shops per order (compartments A and B).
insert into shops (id, name, fee_bps) values
  ('noodles', 'Noodle House', 1000),
  ('greens', 'Green Bowl', 1000)
on conflict (id) do nothing;
insert into items (id, shop_id, name, price_cents, grams, stock) values
  ('chicken-noodle', 'noodles', 'Chicken noodle soup', 1250, 600, 20),
  ('dumplings', 'noodles', 'Pork dumplings (6)', 950, 250, 25),
  ('caesar', 'greens', 'Chicken caesar salad', 1100, 350, 15),
  ('fruit-cup', 'greens', 'Fresh fruit cup', 550, 200, 20)
on conflict (id) do nothing;
