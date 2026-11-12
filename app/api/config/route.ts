// What the browser needs: the right pay button (the client id is public by design), whether
// the guided tour is switched on (TOUR=on), and the sandbox buyer logins to show for testers.
export const dynamic = 'force-dynamic';

// SANDBOX_BUYERS="buyer1@example.com password1, buyer2@example.com password2"
// Sandbox test accounts only, shown on screen so testers can log in to the PayPal popup.
// ponytail: comma/space separated; a password containing a comma or space won't parse.
const buyers = () => (process.env.SANDBOX_BUYERS ?? '').split(',').map((s) => s.trim().split(/\s+/))
  .filter(([email, password]) => email?.includes('@') && password).map(([email, password]) => ({ email, password }));

export function GET() {
  const sandbox = process.env.PAYPAL_MODE === 'sandbox';
  return Response.json({
    mode: sandbox ? 'sandbox' : 'mock',
    clientId: process.env.PAYPAL_CLIENT_ID ?? null,
    tour: process.env.TOUR === 'on',
    buyers: sandbox ? buyers() : [],
  });
}
