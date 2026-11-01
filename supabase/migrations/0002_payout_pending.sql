-- Payouts land ~20 s after the batch is created: track them as pending until PayPal confirms.
alter table orders drop constraint orders_status_check;
alter table orders add constraint orders_status_check check (status in (
  'created','held','collecting','en_route','at_door',
  'captured','partially_captured','voided','returning','paying_out','paid_out','failed'));
alter table ledger drop constraint ledger_kind_check;
alter table ledger add constraint ledger_kind_check check (kind in (
  'held','captured','voided','fee','payout_pending','paid_out','refunded'));
