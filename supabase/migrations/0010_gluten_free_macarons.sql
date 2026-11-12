-- A gluten-free bakery snack (almond flour, no wheat): the coffee pairing for gluten-free callers.
-- Not final sale: boxed and sealed, so the bakery can sell it again if it comes back.
insert into items (id, shop_id, name, price_cents, grams, stock, final_sale) values
  ('macarons', 'bakery', 'Almond macarons (3) · gluten-free', 650, 60, 20, false)
on conflict (id) do nothing;
