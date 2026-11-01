// PayPal sandbox spike: hold $13.50, charge $4.50 (final_capture releases the rest), pay the bakery.
//   node --env-file=.env scripts/spike.ts create         -> prints approval link
//   node --env-file=.env scripts/spike.ts finish <id>    -> after the buyer approves
//   node --env-file=.env scripts/spike.ts payout         -> payout step only (operator needs a balance)
import * as pp from '../lib/paypal.ts';

process.env.PAYPAL_MODE = 'sandbox'; // read per call, so setting it after import is fine
const [cmd, orderId] = process.argv.slice(2);
const tag = `spike-${Date.now().toString(36)}`;

if (cmd === 'create') {
  const o = await pp.createOrder(1350, `${tag}-create`, 'https://example.com/liftdrop-approved');
  console.log('order', o.id);
  console.log('approve as the sandbox buyer:', o.approveUrl);
} else if (cmd === 'finish' && orderId) {
  const { authorizationId } = await pp.authorizeOrder(orderId, `${tag}-authorize`);
  console.log('authorized', authorizationId, (await pp.get(`/v2/payments/authorizations/${authorizationId}`)).status);

  const cap = await pp.captureAuthorization(authorizationId, 450, `${tag}-capture`);
  const retry = await pp.captureAuthorization(authorizationId, 450, `${tag}-capture`);
  console.log('captured $4.50', cap.id, cap.status, '| retry same id:', retry.id === cap.id);

  const auth = await pp.get(`/v2/payments/authorizations/${authorizationId}`);
  console.log('authorization after final_capture:', auth.status, '(want CAPTURED/PARTIALLY_CAPTURED with nothing left to capture)');
  try {
    await pp.captureAuthorization(authorizationId, 100, `${tag}-capture2`);
    console.log('WARNING: second capture succeeded, so the remaining hold was NOT released');
  } catch (e) {
    console.log('second capture rejected as expected:', (e as pp.PayPalError).issue);
  }

  await payout();
} else if (cmd === 'payout') {
  await payout();
} else {
  console.log('usage: create | finish <orderId> | payout');
}

async function payout() {
  const email = process.env.PAYOUT_EMAIL_BAKERY!;
  const batch = await pp.createPayout(`${tag}-payout`, [{ shop_id: 'bakery', email, cents: 405 }]);
  console.log('payout batch', batch.batchId, batch.status);
  for (let i = 0; i < 10; i++) {
    const b = await pp.get(`/v1/payments/payouts/${batch.batchId}`);
    console.log('  poll', b.batch_header.batch_status, b.items?.[0]?.transaction_status ?? '');
    if (['SUCCESS', 'DENIED', 'CANCELED'].includes(b.batch_header.batch_status)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
