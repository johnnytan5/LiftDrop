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
- [ ] PayPal sandbox: `PAYPAL_MODE=sandbox`, client id/secret, shop payout emails; check `final_capture` releases the rest; enable Payouts
- [x] LLM key set (Muse Spark replies in ~1.8 s)
- [ ] Verify handoff agent on the ambiguous case
- [ ] Devpost pages (needs Claude in Chrome connected)

## Next (no credentials needed)

- Order page (`/order`) with PayPal JS SDK button (`intent=authorize`) + mock approve
- Order assistant (`/api/assistant`)
- Sim: tower scene, two compartments, touch sensors, lift (plan §4)
