import * as db from '../../../../lib/db.ts';
import { respond } from '../../_respond.ts';

type Ctx = { params: Promise<{ id: string }> };

// Shop tablet: mark a product final sale (charged even if the customer doesn't collect it).
// ponytail: no shop login, like the rest of the tablet; add vendor auth before real shops use it.
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const { final_sale } = (await req.json()) as { final_sale?: unknown };
  return respond(async () => {
    if (typeof final_sale !== 'boolean') throw new Error('final_sale must be true or false');
    return db.updateItem(id, { final_sale });
  });
}
