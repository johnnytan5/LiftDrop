// PayPal Orders v2 (AUTHORIZE intent), Payments v2 and Payouts v1.
// PAYPAL_MODE=sandbox calls api-m.sandbox.paypal.com; anything else uses the in-memory mock,
// which enforces the same rules (capture <= authorized, nothing after final capture or void)
// and the same idempotency (same PayPal-Request-Id -> same response).

const BASE = 'https://api-m.sandbox.paypal.com';
const mode = () => (process.env.PAYPAL_MODE === 'sandbox' ? 'sandbox' : 'mock');
export const usd = (cents: number) => (cents / 100).toFixed(2);

export type PayoutItem = { shop_id: string; email: string; cents: number };

export class PayPalError extends Error {
  issue: string;
  debugId?: string;
  constructor(issue: string, message: string, debugId?: string) {
    super(message);
    this.issue = issue;
    this.debugId = debugId;
  }
}

// ---------- sandbox ----------

let token: { value: string; expires: number } | null = null;

async function accessToken() {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new PayPalError('AUTH_FAILED', `paypal token ${res.status}`);
  const j = await res.json();
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function call(path: string, body: unknown, requestId: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const j = text ? JSON.parse(text) : {};
  if (!res.ok) throw new PayPalError(j.details?.[0]?.issue ?? j.name ?? `HTTP_${res.status}`, j.message ?? text, j.debug_id);
  return j;
}

/** Sandbox GET, for status checks (authorization, payout batch). */
export async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const j = await res.json();
  if (!res.ok) throw new PayPalError(j.name ?? `HTTP_${res.status}`, j.message ?? '', j.debug_id);
  return j;
}

// ---------- mock ----------

type MockAuth = { amount: number; captured: number; closed: boolean };
const m = globalThis as { __pp?: { seq: number; orders: Map<string, number>; auths: Map<string, MockAuth>; replies: Map<string, unknown>; fail: string | null } };
const mock = () => (m.__pp ??= { seq: 0, orders: new Map(), auths: new Map(), replies: new Map(), fail: null });
const mid = (p: string) => `${p}${(++mock().seq).toString().padStart(6, '0')}MOCK`;

/** Make the next mock call of this op throw (for fault demos and the self-check). */
export function setMockFailure(op: 'capture' | 'void' | 'payout' | 'authorize' | null) { mock().fail = op; }
export function resetMock() { m.__pp = undefined; }

function once<T>(requestId: string, op: string, fn: () => T): T {
  const s = mock();
  if (s.replies.has(requestId)) return s.replies.get(requestId) as T;
  if (s.fail === op) { s.fail = null; throw new PayPalError('MOCK_FAILURE', `mock ${op} failure`); }
  const r = fn();
  s.replies.set(requestId, r);
  return r;
}

// ---------- API ----------

/** returnUrl only for redirect checkout (spike script); the JS SDK button doesn't need it. */
export async function createOrder(cents: number, requestId: string, returnUrl?: string): Promise<{ id: string; approveUrl?: string }> {
  if (mode() === 'mock') return once(requestId, 'create', () => { const id = mid('ORD'); mock().orders.set(id, cents); return { id }; });
  const j = await call('/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{ amount: { currency_code: 'USD', value: usd(cents) }, description: 'LiftDrop delivery' }],
    ...(returnUrl ? { payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: returnUrl, user_action: 'CONTINUE' } } } } : {}),
  }, requestId);
  return { id: j.id, approveUrl: j.links?.find((l: { rel: string }) => l.rel === 'approve' || l.rel === 'payer-action')?.href };
}

/** Call after the buyer approves in the PayPal popup. Reserves funds; charges nothing. */
export async function authorizeOrder(orderId: string, requestId: string): Promise<{ authorizationId: string }> {
  if (mode() === 'mock') return once(requestId, 'authorize', () => {
    const amount = mock().orders.get(orderId);
    if (amount === undefined) throw new PayPalError('RESOURCE_NOT_FOUND', `no order ${orderId}`);
    const authorizationId = mid('AUTH');
    mock().auths.set(authorizationId, { amount, captured: 0, closed: false });
    return { authorizationId };
  });
  const j = await call(`/v2/checkout/orders/${orderId}/authorize`, {}, requestId);
  return { authorizationId: j.purchase_units[0].payments.authorizations[0].id };
}

/** final_capture=true releases whatever is left of the hold, so partial delivery is one call. */
export async function captureAuthorization(authId: string, cents: number, requestId: string): Promise<{ id: string; status: string }> {
  if (mode() === 'mock') return once(requestId, 'capture', () => {
    const a = mock().auths.get(authId);
    if (!a) throw new PayPalError('RESOURCE_NOT_FOUND', `no authorization ${authId}`);
    if (a.closed) throw new PayPalError('AUTHORIZATION_ALREADY_CAPTURED', 'authorization closed');
    if (cents <= 0 || a.captured + cents > a.amount) throw new PayPalError('MAX_CAPTURE_AMOUNT_EXCEEDED', 'capture exceeds authorization');
    a.captured += cents;
    a.closed = true;
    return { id: mid('CAP'), status: 'COMPLETED' };
  });
  const j = await call(`/v2/payments/authorizations/${authId}/capture`, {
    amount: { currency_code: 'USD', value: usd(cents) }, final_capture: true,
  }, requestId);
  return { id: j.id, status: j.status };
}

export async function voidAuthorization(authId: string, requestId: string): Promise<void> {
  if (mode() === 'mock') return once(requestId, 'void', () => {
    const a = mock().auths.get(authId);
    if (!a) throw new PayPalError('RESOURCE_NOT_FOUND', `no authorization ${authId}`);
    if (a.closed) throw new PayPalError('PREVIOUSLY_VOIDED', 'authorization closed');
    a.closed = true;
  });
  await call(`/v2/payments/authorizations/${authId}/void`, {}, requestId);
}

/** One batch per order; sender_batch_id makes retries safe. */
export async function createPayout(batchId: string, items: PayoutItem[]): Promise<{ batchId: string; status: string }> {
  if (mode() === 'mock') return once(batchId, 'payout', () => ({ batchId: mid('PAYOUT'), status: 'SUCCESS' }));
  const j = await call('/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: batchId, email_subject: 'LiftDrop payout' },
    items: items.map((i) => ({
      recipient_type: 'EMAIL', receiver: i.email, sender_item_id: `${batchId}-${i.shop_id}`,
      amount: { currency: 'USD', value: usd(i.cents) }, note: 'LiftDrop delivered items, minus fee',
    })),
  }, batchId);
  return { batchId: j.batch_header.payout_batch_id, status: j.batch_header.batch_status };
}
