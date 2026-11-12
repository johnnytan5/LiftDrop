-- Fresh food a shop won't take back: charged even if the customer doesn't collect it.
-- Copied onto order_items when the order is placed, so a later toggle never changes a placed order.
alter table items add column if not exists final_sale boolean not null default false;
alter table order_items add column if not exists final_sale boolean not null default false;
