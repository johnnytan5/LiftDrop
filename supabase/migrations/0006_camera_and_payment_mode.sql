-- Payment mode: 'hold' authorizes and captures only what was taken; 'charge' captures the full
-- amount at order time and refunds what was left. Compartment cameras: SAM 3.1 results for the
-- photo taken as the doors open (before) and as they close (after).
alter table orders add column payment_mode text not null default 'hold' check (payment_mode in ('hold', 'charge'));
alter table compartments add column vision_before jsonb;
alter table compartments add column vision_after jsonb;
