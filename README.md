# LiftDrop

Robot delivery for office towers, paid with PayPal. You order from the shops in the lobby, by app or by phone call. A robot brings the order up the lift to your floor, and you pay only for what you take out.

Built for the PayPal AI Hackathon, 2026.

![LiftDrop robot](public/landing-robot.webp)

## The problem

A lot of office workers eat at their desks, and the shops in the lobby lose that lunch to delivery apps that charge them 15–30% and send a courier who can't get past the security gate. LiftDrop keeps the order in the building: the lobby shops sell to the floors above them, and the robot handles the lift and the gate.

## How it works

1. **Order.** The customer picks from four lobby counters (café, bakery, noodles, salad) in the phone app, or calls the order line and talks to a voice agent.
2. **Hold.** PayPal authorizes the full basket. Nothing is captured yet.
3. **Collect.** The robot visits each shop. The shop's tablet shows the order, a compartment opens, and staff load it.
4. **Deliver.** The robot rides the lift to the customer's floor (L20 or L23) and waits at the security gate. The customer unlocks it with a 4-digit code.
5. **Check.** Each compartment has a scale and a camera. Before the doors open and after they close, the weight is compared and SAM 3.1 looks for each dish in the photo.
6. **Settle.** PayPal captures only what was taken and voids the rest. Items left behind ride back to their shop. Items marked *final sale* (drinks, soup) are charged once made.
7. **Pay shops.** PayPal Payouts sends each shop its share, less a 5% platform fee, the moment the order settles.

When the scale and camera disagree, an LLM agent reads both and decides (Muse Spark, or any OpenAI-compatible model). With no key set it falls back to a fixed rule set, and anything it can't decide goes to the ops console.

## PayPal

| Step | API |
|---|---|
| Hold the basket | Orders v2: create (`intent: AUTHORIZE`) + authorize |
| Charge what was taken | Payments v2: capture an authorization (partial) |
| Release the rest | Payments v2: void an authorization |
| Pay each shop | Payouts v1: one batch per order, one item per shop |

All money moves are idempotent (`PayPal-Request-Id`) and recorded in a ledger table, so a retry never charges twice. Code: `lib/paypal.ts`, `lib/orders.ts`, `lib/handoff.ts`.

## The demo

| URL | What it is |
|---|---|
| `/` | Landing page |
| `/demo` | The live demo: customer phone + robot sim, shop tablet and ops console under one toggle (`?view=user\|vendor\|ops`). All three stay running when you switch. |
| `/order` | The customer app on its own, for a real phone |
| `/vendor?shop=cafe` | A shop's tablet (`cafe`, `bakery`, `noodles`, `greens`) |
| `/ops` | Ops console: orders that need a person, fleet, ledger |

With `TOUR=on`, a pointer walks first-time visitors through one order across all three views, moving on as the app actually gets there.

The robot and the tower are simulated live in the browser with MuJoCo (WASM) and drawn with three.js. The compartment cameras render real frames from the sim, and those frames are what SAM 3.1 sees.

## Run it

Needs Node 24 (the tests run TypeScript directly).

```bash
npm install
cp .env.example .env
npm run dev          # http://localhost:3000
```

With an empty `.env` everything runs on mocks: PayPal is simulated, the database is in memory, and the handoff uses the fixed rules. Fill in keys to turn on each real service:

| Variables | Turns on |
|---|---|
| `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | PayPal sandbox checkout, capture, void |
| `PAYOUT_EMAIL_CAFE` / `_BAKERY` / `_NOODLES` / `_GREENS` | Payouts to each shop's sandbox business account |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres storage. Apply `supabase/migrations/*.sql` in order. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (or `OPENROUTER_API_KEY`) | LLM handoff agent |
| `META_API_KEY` | Muse Spark for the phone call, SAM 3.1 for the cameras |
| `ASSEMBLYAI_API_KEY` | Speech-to-text and text-to-speech for the phone call |
| `OPS_TOKEN` | Optional: locks the operator actions on `/api/ops` (sent as `x-ops-token`). |
| `SANDBOX_BUYERS` | PayPal sandbox buyer logins (`email password, email password`) shown under the demo phone with copy buttons, sandbox mode only |
| `TOUR=on` | Guided tour over `/` and `/demo`: first-time visitors are asked once, and a corner switch turns it on or off. Any other value hides it completely. |

## Deploy

Runs on Vercel as is (or any Node host with `npm run build && npm start`). No server memory is relied on:
robot heartbeats live in the `robots` table, the payout batch is sent through Next's `after()`, and
payouts in progress, unclaimed orders and robots stuck at the door are swept on each `/api/state` read.
Set the variables above in the project settings, including `NEXT_PUBLIC_PAYPAL_CLIENT_ID` before the
first build (it is baked into the page), and apply `supabase/migrations/*.sql`.

## Tests

```bash
npm run typecheck
npm run check        # unit tests: order lifecycle, handoff decisions, camera checks, fleet, ops, sim, call tools
npm run e2e          # browser run of the full demo; start the server with PAYPAL_MODE=mock first
```

## Layout

```
app/            pages and API routes (Next.js 16 app router)
components/     phone app, call screen, robot stage, tower view, shop tablet parts
lib/            orders, PayPal, handoff, vision, call agent, sim (MuJoCo tower controller)
sim/            MuJoCo scene: tower, lift, robot
supabase/       database migrations
scripts/        e2e test, cover render, demo footage capture
```

## Limits

- The robot, lift and building are simulated. The control code and the compartment checks are written against the sim's sensors, not a real robot.
- The final-sale toggle (`/api/items/[id]`) has no auth, and the voice and vision routes have no rate limit yet.

## License

MIT
