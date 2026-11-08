# LiftDrop: BRD/PRD review and implementation plan

Reviewed 2026-10-30 against `Tower Robot Commerce BRD & PRD.md`, the PayPal hackathon blog post and the PayPal sandbox guide (see `hackathon_docs/`). Devpost overview/rules/resources not yet fetched (403), so anything sourced only from Devpost is marked **unverified**.

## 1. Verdict

Strong concept, right core. "Money moves only on physical proof" is a clear, demo-able idea and the BRD correctly makes the payment lifecycle + handoff agent the non-cuttable core. Main risks are not the idea but: currency mismatch, robot sim scope, the AI looking like if-statements, and a few PayPal API details that make the design more complex than it needs to be.

## 2. Issues found

### Must fix

| # | Issue | Why it matters | Fix |
| --- | --- | --- | --- |
| 1 | **Currency: RM prices, US sandbox accounts.** ✅ Decided: USD. | MYR on PayPal is limited to in-country Malaysian accounts; a US buyer authorizing MYR and Payouts in MYR are likely to fail or behave oddly. Judges are mostly US. | Run everything in **USD** (croissant $4.50, latte $9.00, total $13.50, payout $4.05 keep the same numbers). Mention Malaysia only in the pitch. |
| 2 | **Capture-then-void is two calls where one works.** | `POST /v2/payments/authorizations/{id}/capture` with `"final_capture": true` captures the delivered amount and releases the rest. Separate void after a partial capture adds a failure point. | Partial delivery = one capture with `final_capture: true`. Nothing taken = `void`. Full = capture full amount. Verify on Nov 5 spike that the remaining hold is released (fallback: explicit void). |
| 3 | **Idempotency keys must be deterministic.** | A random `PayPal-Request-Id` per retry defeats idempotency. | Derive keys from order: `liftdrop-{order_id}-capture`, `-void`, `-refund-{n}`; `sender_batch_id = liftdrop-{order_id}-payout`. Store PayPal response before advancing state. |
| 4 | **SDK intent must match.** | JS SDK script needs `intent=authorize` *and* server order created with `intent: "AUTHORIZE"`; mismatch errors at approval. | Add to spike checklist. |
| 5 | **Deadline needs one source of truth.** | Blog says submissions close Nov 12, 2026; BRD says Nov 13 01:30 IST (= Nov 12 12:00 PST, US DST ends Nov 1). Devpost unverified. | Confirm on Devpost; treat **Nov 12 12:00 PT** as hard cut until confirmed. Plan has submit on Nov 12, keep it to the morning. |
| 6 | **Prior-work / overlap rule unverified** (BRD open question 4). | Disqualification risk; Concierge robot model is reused. | Read Devpost rules before Nov 5. README "what's reused vs new" section either way. |

### Should fix

| # | Issue | Fix |
| --- | --- | --- |
| 7 | **"Captured instantly" vs LLM latency.** Handoff agent call adds 1–3 s at the money moment. | Use a fast model; start the agent call on `door_closed`/timeout, show "Verifying handoff…" for the gap. Script the video around it. |
| 8 | **Thin-AI risk is real.** Code computes the cap; with clean sensors the agent is a lookup. | Make the agent's input facts genuinely ambiguous in 2 of 3 demo cases: weight drop ≠ item weight, door opened but nothing removed, item removed then returned. Agent output = action + amount (≤ cap) + customer message + operator reason. |
| 9 | **Refund (F4) is P0 but in no demo scene.** | Demote refund to P1; implement only if time. |
| 10 | **Webhooks (F6).** ✅ Status pushed to UIs via Supabase Realtime instead of own WebSocket. Capture/void/payout responses are synchronous; payout items need polling anyway. | Skip webhooks. Poll `GET /v1/payments/payouts/{batch_id}` until terminal. |
| 11 | **Robot sim is the schedule killer.** MuJoCo WASM + three.js + lift + compartments in one day (Nov 8). | Freeze the event contract first (§4). Sim v0 = fake buttons, v1 = kinematic three.js scene (scripted waypoints, sensors as numbers), v2 = MuJoCo only if Concierge already runs it. Judges score the money moment, not physics. |
| 12 | **Prize targeting.** "Best Use of PayPal + AI" is also an honorable mention and fits this project best. AG Grid prize is the most winnable sponsor prize ($5k first). | Target Best Use of Agentic Commerce + PayPal + AI. **AG Grid dropped (Nov 8):** a data grid is overkill for a two-shop delivery robot and would eat time in a <3 min pitch; the live money panel on the stage and the /vendor earnings already show the numbers. Optional only if time is spare on Nov 11: swap the /vendor earnings table for AG Grid, kept out of the video. |
| 13 | **Who pays PayPal fees** isn't stated. Shop payout = items − 10%; operator absorbs PayPal processing + payout fees. | One line in BRD business model; show the operator's net in the console. |
| 14 | **Judges need to try it.** | README: a sandbox buyer login for the live demo, and a "demo mode" that auto-loads/delivers so judges don't need the vendor console. |

### Fine as written

Authorization validity (3-day honor, 29-day validity), single payee = operator + Payouts to shops, partner/marketplace splits as roadmap, code-enforced guardrails, cut order, spike-first schedule.

## 3. Decisions (2026-10-30)

| Topic | Decision |
| --- | --- |
| Currency | USD everywhere |
| LLM | One OpenAI-compatible client (`fetch`, pattern from `MuseConcierge/lib/meta/client.ts`). Default Muse Spark (`muse-spark-1.1`, `https://api.meta.ai/v1`); fallback OpenRouter `openai/gpt-6-luna` (`https://openrouter.ai/api/v1`). Switch by env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. |
| Database | Supabase (Postgres + Realtime). **Mocked first**: in-memory store behind `lib/db.ts`, same function signatures; real Supabase swapped in when the project is set up. Migration SQL written up front so the mock mirrors it. |
| PayPal | Real sandbox once credentials exist; until then `lib/paypal.ts` has a mock mode (`PAYPAL_MODE=mock`) returning realistic response shapes, incl. a forced-error switch. |
| Stack | **Next.js (App Router, TS)**, not FastAPI + Vite: the reusable sim pipeline, Muse client and realtime hook from Concierge/MuseConcierge are all TS/Next. API routes hold PayPal + LLM secrets. |
| Hosting | Render web service (long-running Node, so the in-memory mock survives between requests; also eligible for the Render sponsor prize). |

## 4. What we reuse from Concierge (disclose in README)

From `~/Downloads/Concierge`:

| Asset | Path | Use in LiftDrop |
| --- | --- | --- |
| MuJoCo WASM worker | `dashboard/lib/sim/sim.worker.ts` | Physics in a web worker (`@mujoco/mujoco` ^3.14), 120 Hz |
| three.js renderer | `dashboard/components/SimView.tsx` | Primitive geoms, follow cam |
| Asset sync | `dashboard/scripts/sync-sim-assets.mjs` | Copies XML + wasm into `public/` |
| Robot | `sim/delivery_bot_v2.xml` | Diff-drive bot; lid slide actuators + `jointpos` sensors = door sensing |
| Nav | `task_engine/nav.py`, `waypoints.json` | Port pure pursuit to TS (~60 lines) |
| Delivery FSM | `task_engine/engine.py` loading/arrival sequences | Port idea, not code |
| Realtime hook | `dashboard/lib/useRealtimeTable.ts` | UIs subscribe to `orders`, `ledger`, `decisions` |

**Gaps to build (none exist in either repo):**

1. **Two compartments.** Robot has one. Add a divider shelf → compartment A (top) / B (bottom), each with its own slide door actuator + `jointpos` sensor.
2. **Weight sensors.** None exist and `payload_demo` has no collision. Make each payload a free body with a collision geom; add a `touch` sensor on a site on each compartment floor (reads ≈ m·g). Calibration knob: `GRAMS_PER_NEWTON` + tare per compartment, since contact force jitters.
3. **Customer takes item.** Worker message `{type:'take', compartment}` moves that payload body out (set qpos off-robot). Fault injection = don't take / take then return / take a different-weight item.
4. **Lift + floors.** New `scene_tower.xml`: lobby at z=0 (bakery + café counters, lift), level 23 at z=3 (pantry). Lift car = body on a slide joint with a position actuator (same pattern as the lid). Fallback if the robot jitters riding the car: teleport robot between floors while the car animates.
5. **Sim → backend.** Worker already posts frames to the main thread; add a small bridge on the ops page that turns sensor threshold crossings into the §5 events and POSTs them to `/api/events`.

## 5. Event contract (freeze first)

Sim, fake buttons and fault injection all POST the same events to `/api/events`, so sim fidelity can change without touching money code.

```json
{"order_id": "o_42", "type": "loaded",      "compartment": "A", "shop": "bakery"}
{"order_id": "o_42", "type": "arrived",     "floor": 23}
{"order_id": "o_42", "type": "door_opened", "compartment": "A"}
{"order_id": "o_42", "type": "weight",      "compartment": "A", "grams": 0}
{"order_id": "o_42", "type": "door_closed", "compartment": "A"}
{"order_id": "o_42", "type": "timeout"}
```

Verifier → per-compartment facts `{compartment, items, value, expected_g, start_g, end_g, door_opened, removed: true|false|ambiguous}`. **Cap** = value of compartments with `removed=true`. Agent picks `capture(amount ≤ cap) | wait(s ≤ 120) | void` + customer message + operator reason; code clamps, logs to `decisions`.

## 6. Layout

```
app/
  order/page.tsx          phone order page (?loc=L23-pantry), assistant, PayPal button, status
  vendor/[shop]/page.tsx  orders to pack, "Loaded", earnings
  api/orders/...          create (PayPal order), authorize, status
  api/events/route.ts     sensor events -> verifier -> handoff
  api/assistant/route.ts  NL -> cart
lib/
  db.ts         mock now, Supabase later (same exports)
  paypal.ts     token, create, authorize, capture(final_capture), void, payouts, poll; mock mode
  orders.ts     state machine + ledger (only place transitions happen)
  handoff.ts    facts -> cap -> agent -> paypal
  llm.ts        OpenAI-compatible fetch client
  sim/          worker + bridge (from Concierge)
public/sim/     delivery_bot_v3.xml, scene_tower.xml
supabase/migrations/0001_init.sql  shops, items, orders, order_items, compartments, events, ledger, decisions
```

State machine: `created → held → collecting → en_route → at_door → {captured | partially_captured | voided} → paid_out`, plus `failed`, `returning`.

## 7. Day plan

**Now, while Supabase/PayPal aren't set up (mocks)**
- [ ] Next.js scaffold, `0001_init.sql`, mock `db.ts`, mock `paypal.ts`
- [ ] `orders.ts` + `handoff.ts` with code cap and a runnable self-check (full / partial / none / ambiguous)
- [ ] `/api/events` + fake-button page: whole money lifecycle clickable on mocks

**When you're back (needs your accounts)**
- [ ] Supabase project → apply migration → swap `db.ts` → realtime hook
- [ ] PayPal sandbox: operator business, 2 shop business, 1 US buyer; app credentials; enable Payouts; verify `final_capture` partial release + payouts on sandbox
- [ ] Read Devpost rules (prior-work clause, deadline, prize stacking)

**Nov 5–12** (as before)
- Nov 5–6: real PayPal + Supabase wired; order page with PayPal button
- Nov 7: milestone, full lifecycle on sandbox by clicking
- Nov 8: tower scene, 2 compartments, touch sensors, lift, sim bridge
- Nov 9: handoff agent (Muse Spark) + order assistant + ambiguous faults
- Nov 10: vendor console (done Nov 8); no ops console or AG Grid, time goes to product polish and the pitch
- Nov 11: Render deploy, README (reuse disclosure, sandbox buyer login), video
- Nov 12: submit by morning PT

Cut order: AG Studio → order assistant → MuJoCo lift (teleport) → refund. Never cut handoff agent or partial capture.

## 8. Open items

1. Devpost overview/rules/resources: need Claude in Chrome connected (Devpost 403s automated fetch).
2. Supabase project + PayPal sandbox credentials: owner to set up.
