-- Signals that cross devices: the customer's phone, the shop's tablet and the robot sim
-- (running in whichever browser claimed the order) only meet in the database.
alter table orders add column robot_session text;           -- sim tab driving this order
alter table orders add column customer_done_at timestamptz; -- phone: "I've taken my order"
alter table compartments add column vendor_loaded_at timestamptz; -- shop: "Loaded"
