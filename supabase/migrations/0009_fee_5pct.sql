-- LiftDrop's fee drops from 10% to 5% of what the customer took.
update shops set fee_bps = 500;
alter table shops alter column fee_bps set default 500;
