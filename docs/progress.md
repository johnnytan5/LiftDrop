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
- [ ] Clean handoff takes ~4.3 s on Supabase (~13 sequential DB round trips): return after capture, do payouts in background, parallelise reads
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
