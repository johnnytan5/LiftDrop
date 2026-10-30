import { snapshot } from '../../../lib/db.ts';

export const dynamic = 'force-dynamic';
export const GET = () => snapshot().then((s) => Response.json(s));
