// What the order line knows beyond names and prices: what each dish is, and the house rules.
// Which items are final sale is NOT here: shops switch it on their tablet during the day, so the
// prompt reads it from the live menu each turn (prompt.ts).
// ponytail: one static sheet in the prompt; move to a table or retrieval when it outgrows a page.

import { OFFICES } from './tools.ts';

/** One line per dish: what it is, size, hot or cold, and what it contains. */
export const DISHES: Record<string, string> = {
  croissant: 'all-butter croissant baked this morning; served at room temperature; contains wheat, milk, egg; vegetarian',
  'pain-choc': 'croissant pastry with two bars of dark chocolate; room temperature; contains wheat, milk, egg, soy; vegetarian',
  macarons: 'GLUTEN-FREE: three almond-flour macarons (vanilla, pistachio, raspberry), no wheat at all; boxed and sealed; contains almonds, egg, milk; vegetarian; the bakery’s pick to go with a coffee',
  'iced-latte': '16 oz, double espresso and whole milk over ice; contains milk; no other milks or syrups on this line',
  americano: '12 oz, double espresso topped with hot water, black; dairy-free; milk is not available on this line',
  'chicken-noodle': 'large bowl of hot chicken broth with egg noodles, shredded chicken and greens, ladled when ordered; contains wheat, egg',
  dumplings: 'six steamed pork and cabbage dumplings with soy dipping sauce; hot; contains wheat, soy',
  caesar: 'romaine, grilled chicken, parmesan and croutons, dressing on the side; cold; contains wheat, milk, egg, fish (anchovy in the dressing)',
  'fruit-cup': 'freshly cut seasonal fruit, cut when ordered; cold; vegan, no common allergens',
};

export const POLICIES = `- Final sale: a shop marks a dish final sale when it is made to order and can't be sold again once it leaves the counter (a poured drink, a ladled soup, cut fruit). It is charged even if the customer leaves it in the robot. Everything else is charged only if it is taken out.
- How paying works: PayPal holds the order total when the customer approves. When the robot's doors close, its scale and camera check what was taken; PayPal then charges for that and releases the rest of the hold. If the scale and camera disagree, an AI agent decides, and if it can't, a person on the ops team reviews it.
- Anything left in the robot goes back to its shop and isn't charged (unless it is final sale).
- No delivery fee and no tip. Customers pay menu prices; the shops pay LiftDrop a small share.
- The robot delivers to Level 20 (${OFFICES[20]}) and Level 23 (${OFFICES[23]}) only, from at most two shops per order, one compartment per shop.
- At the floor the robot waits outside the office's security gate and "calls" the customer in the app. The app shows a 4-digit code to type on the robot's screen; that opens the compartments.
- Payment is by PayPal only.
- If no robot can take the order before it reaches the gate, it is cancelled and the hold is released.`;
