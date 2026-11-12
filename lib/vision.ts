// What the compartment cameras check. Before the doors open and again as they close, SAM 3.1
// looks for each dish in the compartment's photo. Pure helpers; the model calls are in
// app/api/vision. Adapted from MuseConcierge lib/vision/doorcheck.ts (cabin check).

export type Box = { x1: number; y1: number; x2: number; y2: number; w: number; h: number; c: number };

/** How each dish is packed (what the camera sees), and what SAM 3.1 is asked for it, best first. */
export type Pack = 'iced_cup' | 'hot_cup' | 'fruit_cup' | 'soup_bowl' | 'salad_box' | 'croissant' | 'pastry_box' | 'dumpling_box';
export const PACK: Record<string, Pack> = {
  'iced-latte': 'iced_cup', americano: 'hot_cup', 'fruit-cup': 'fruit_cup',
  'chicken-noodle': 'soup_bowl', caesar: 'salad_box',
  croissant: 'croissant', 'pain-choc': 'pastry_box', macarons: 'pastry_box', dumplings: 'dumpling_box',
};
// ponytail: prompts picked on rendered compartment frames (/camera-check); re-check them there
// after changing a dish's model in components/compartmentCam.ts.
export const PROMPTS: Record<Pack, string[]> = {
  iced_cup: ['cup', 'drink'],
  hot_cup: ['cup', 'drink'],
  fruit_cup: ['cup', 'fruit'],
  soup_bowl: ['noodles', 'bowl'],
  salad_box: ['box', 'salad'],
  croissant: ['croissant'],
  pastry_box: ['box', 'pastry'],
  dumpling_box: ['box'],
};

// SAM answers in text: <|box;x1=419;y1=137;x2=656;y2=641;w=1024;h=768;c=0.90|>
export function parseBoxes(text: string): Box[] {
  return [...text.matchAll(/<\|box;([^|]*)\|>/g)]
    .map((m) => Object.fromEntries(m[1].split(';').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)])))
    .filter((b) => ['x1', 'y1', 'x2', 'y2', 'w', 'h', 'c'].every((k) => Number.isFinite(b[k])))
    .sort((a, b) => b.c - a.c) as Box[];
}

function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const shared = w * h;
  return shared / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - shared);
}

// SAM answers each prompt alone, so two cups can land on the same cup. One object is never two
// dishes: the dish with the fewest candidates picks first (ties go to the surest), the others
// take their best box that isn't already taken.
export function assignBoxes(candidates: Record<string, Box[]>): Record<string, Box | null> {
  const taken: Box[] = [];
  const found: Record<string, Box | null> = {};
  const best = (k: string) => Math.max(0, ...candidates[k].map((b) => b.c));
  const keys = Object.keys(candidates).sort((a, b) => candidates[a].length - candidates[b].length || best(b) - best(a));
  for (const k of keys) {
    const box = candidates[k].find((b) => taken.every((t) => overlap(t, b) < 0.5)) ?? null;
    if (box) taken.push(box);
    found[k] = box;
  }
  return found;
}

/** One photo's result: per dish slot ("croissant#1"), the box SAM found or null; dishes whose
 *  call failed are listed and never count as gone. */
export type CameraCheck = { found: Record<string, Box | null>; failed: string[]; ms: number; at: string };
export type Seen = 'gone' | 'present' | 'partial' | 'unknown';

/** Dish slots for a compartment: one per unit, so 2 croissants are two things to find. */
export const slots = (lines: { item_id: string; qty: number }[]) =>
  lines.flatMap((l) => Array.from({ length: Math.min(l.qty, 3) }, (_, i) => `${l.item_id}#${i + 1}`));

/** A failed call proves nothing, so any failure makes the whole photo 'unknown'. */
export function seen(c: CameraCheck | null | undefined): Seen {
  if (!c || c.failed.length || !Object.keys(c.found).length) return 'unknown';
  const v = Object.values(c.found);
  if (v.every((b) => !b)) return 'gone';
  return v.every(Boolean) ? 'present' : 'partial';
}
