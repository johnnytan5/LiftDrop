# Progress

## Mock-first slice (plan §7 "Now") — done 2026-10-30

- [x] Next.js 16 scaffold (`package.json`, `tsconfig.json`, `.env.example`)
- [x] `supabase/migrations/0001_init.sql` (shops, items, orders, compartments, order_items, events, ledger, decisions; RLS read-only; realtime; seed)
- [x] `lib/db.ts` in-memory mock mirroring the migration
- [x] `lib/paypal.ts` mock + sandbox implementation (authorize, capture with `final_capture`, void, payouts; deterministic idempotency keys)
- [x] `lib/orders.ts` state machine + ledger + shop payouts minus fee
- [x] `lib/handoff.ts` facts, weight classification, code-enforced cap/clamp, deterministic fallback, LLM tool call
- [x] `lib/llm.ts` OpenAI-compatible client (Muse Spark / OpenRouter by env)
- [x] API: `/api/orders`, `/api/authorize`, `/api/events`, `/api/state`, `/api/reset`
- [x] `/dev` fake-button console: approve, load, arrive, take, half-weight fault, timeout
- [x] Verified: `npm run check` (7 tests), `npm run build`, HTTP smoke test of the partial-capture scenario

## Waiting on owner

- [x] Supabase project `duovflifoomrfqpqzpet`: migration applied, `lib/db.ts` uses supabase-js when `SUPABASE_URL` is set (mock otherwise); partial-capture lifecycle verified end to end (2026-10-31)
- [ ] Realtime subscriptions instead of 1 s polling
- [ ] Cut per-event Supabase round trips (~1.1 s/event now)
- [x] PayPal sandbox spike: authorize → capture $4.50 of $13.50 with `final_capture` (rest released, 2nd capture rejected), idempotent retry, payout SUCCESS in ~20 s (2026-11-01)
- [x] Operator moved to a US business account + new app (MY account held MYR, payouts in USD failed)
- [ ] Re-run hold + partial capture on the new US operator app, then set `PAYPAL_MODE=sandbox`
- [x] Payouts tracked as `paying_out` + `payout_pending` ledger rows until PayPal reports the batch SUCCESS (in-process poller, resumed from /api/state after restart)
- [x] Clean handoff 4.3 s → 0.8–1.0 s on Supabase: reply after capture, payouts in background, independent DB calls in parallel
- [x] Policy decided (2026-11-01): untaken items are never charged and go back to the shop (pure "pay only for what you take")
- [x] LLM key set (Muse Spark replies in ~1.8 s)
- [x] Handoff agent verified on the ambiguous case via Muse (wait, then charge A only)
- [x] Clean handoffs decided by code instantly (source `code`); only ambiguous ones call the agent (~4–6 s on Muse)
- [ ] Show "Verifying handoff…" on the order page while the agent decides
- [x] LLM switched to OpenRouter `openai/gpt-6-luna` with reasoning effort minimal: ~1.6–2.4 s per decision vs Muse 4–8 s; correct on the ambiguous case
- [ ] Devpost pages (needs Claude in Chrome connected)

## Next (no credentials needed)

- Order page (`/order`) with PayPal JS SDK button (`intent=authorize`) + mock approve
- Order assistant (`/api/assistant`)
- Sim: tower scene, two compartments, touch sensors, lift (plan §4)

## MuJoCo tower sim (started 2026-11-01)

- [x] `sim/scene_tower.xml`: lobby (café + bakery counters, dock), glass panoramic lift, level 23 slab with pantry table
- [x] `sim/liftdrop_bot.xml` (from Concierge delivery_bot_v2): two compartments A/B, sliding doors, load-cell plates with force sensors (80 g / 450 g read exactly), front + rear casters
- [x] `lib/sim/tower.ts`: velocity-driven base with accel limits, waypoint nav, lift ride, load at counters, customer take / half-weight fault, sensor-driven weight events, timeout, returns untaken items to their shop, docks
- [x] `lib/sim/tower.test.ts`: full headless delivery on the real WASM build (part of `npm run check`)
- [x] Browser: `lib/sim/sim.worker.ts`, `components/TowerView.tsx` (orbit follow cam, glass, labels), `/sim` page forwarding sensor events to `/api/events`
- [ ] Look at `/sim` in a real browser (not yet seen rendered: Chrome extension disconnected)
- [ ] Vendor "Loaded" from the vendor page instead of the /sim panel
- [ ] Customer take/done from the phone order page instead of the /sim panel

## 2026-11-08: consumer flow, split screen, shop tablet

- `/` is the demo: the customer's phone (left) and the live MuJoCo tower (right). They only share the backend.
  The sim claims a held order (first tab wins, `orders.robot_session`), delivers it, and forwards sensor events.
- `/order` is the same phone app full screen, for a real phone. `/vendor?shop=` is the shop tablet: Loaded + earnings.
- Order assistant (`lib/assistant.ts`, `/api/assistant`): the model picks menu ids and quantities only; prices from the DB.
- Pay: PayPal JS SDK button (`intent=authorize`) in sandbox mode, a test-mode button in mock mode (`/api/config`).
  Sandbox checked: the button opens `sandbox.paypal.com/checkoutnow` for the order our backend created. Approving needs
  the sandbox buyer login (yours).
- Cross-device signals (migrations 0003, 0004): `customer_done_at`, `vendor_loaded_at`, `door_closed`.
- Fixes found by testing:
  - Untouched compartment read as "unclear": the robot now reports a final weight for every compartment at close.
  - Two door_closed events ran the handoff twice, so the second overrode the agent's "please check". Now one decision
    per round, once every opened door has closed.
  - Agent "wait": the robot used to drive off. It now reopens its doors and waits for the customer's second "Done".
  - Live scale readout jumped while driving (load cells feel acceleration); it now holds the last still reading.
  - Pantry table and fridge hid the robot from the camera at the door; moved.
- Door backstop: if the sim tab closes at the door, the backend settles after 180 s from what the sensors reported.
- Tests: `npm run check` (13, incl. headless MuJoCo delivery), `npm run e2e` (Chrome, 5 scenarios: partial take,
  full take, nothing taken, shops load by hand, agent asks then charges). All pass on Supabase + mock PayPal + Luna.

## 2026-11-08 (later): Coral Plate design, voice order line, compartment cameras, pay now

- Two more shops (migration 0005): Noodle House and Green Bowl, counters along the lobby's north wall. The robot still
  has two compartments, so the cart, the call agent and `createOrder` all stop at two shops per order.
- Phone app ported to the Halden Tower design, direction 3a "Coral Plate" (`app/coral.css`, `components/OrderApp.tsx`):
  home with shops and dishes, shop menu, basket with the robot's route, tracking, door card and receipt.
- Call your order (`components/CallScreen.tsx`, `lib/call/*`, `lib/voice/*`), pipeline adapted from MuseConcierge:
  mic -> AssemblyAI Universal-Streaming (`/api/asr-token`) -> Muse Spark (`/api/call`, tools `update_basket`,
  `checkout`, `order_status`, `end_call`; the two-shop rule is in code) -> AssemblyAI TTS (`/api/tts`). The caller
  approves in the real PayPal button; the line says goodbye and the phone switches to tracking.
- Compartment cameras (SAM 3.1, as in MuseConcierge's cabin check): `components/compartmentCam.ts` renders each
  compartment with real-size dish models (only dishes whose bag is physically inside it), `/api/vision` asks SAM 3.1
  per dish and stores the result (`vision_before` as the doors open, `vision_after` as they close; migration 0006).
  The handoff combines scale and camera (`combine()` in `lib/handoff.ts`): both must say taken to charge; if they
  disagree the agent asks; a failed SAM call never counts as taken. Bench: `/camera-check` (24/24, three runs:
  every dish found alone and in pairs, nothing found once taken).
- Payment modes (migration 0006 `orders.payment_mode`): "Pay on delivery" authorizes and captures only what was taken
  (as before); "Pay now" captures the full amount at order time and refunds what was left (`paypal.refundCapture`).
- Tests: `npm run check` 26 (call tools, camera verdicts, weight x camera table, pay-now refunds, mock refund limits);
  `npm run e2e` 7 scenarios, scenario 1 ordered by voice through Chrome's fake mic (real AssemblyAI + Spark), scenario 7
  pay now with a $9.00 refund. All pass on Supabase + mock PayPal + Muse Spark + SAM 3.1.
- Not done: per-item charging inside one compartment (two dishes, one taken -> the agent asks; charge stays per
  compartment). The old typed assistant (`/api/assistant`) is unused by the new UI.
