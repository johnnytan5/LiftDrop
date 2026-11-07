-- The handoff runs once per round: when every opened door has closed again. A door opening
-- (first time, or again after the agent asked the customer to check) clears it.
alter table compartments add column door_closed boolean not null default false;
