// What the phone needs to render the right pay button. The client id is public by design.
export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ mode: process.env.PAYPAL_MODE === 'sandbox' ? 'sandbox' : 'mock', clientId: process.env.PAYPAL_CLIENT_ID ?? null });
}
