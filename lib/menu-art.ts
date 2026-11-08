// Photos and counter labels for the phone app (Coral Plate design). Photos are Unsplash, as in
// the design file; three dishes it didn't cover use close matches.
// ponytail: keyed by id here, not in the DB; move to columns if shops edit their own menus.
const u = (id: string, w: number) => `https://images.unsplash.com/photo-${id}?w=${w}&h=${w}&q=70&auto=format&fit=crop`;

const ITEM: Record<string, { photo: string; unit: string }> = {
  'chicken-noodle': { photo: '1569718212165-3a8278d5f624', unit: '1 bowl' },
  dumplings: { photo: '1651399436026-3ca4088b3d6e', unit: '6 pieces' },
  caesar: { photo: '1546793665-c74683f339c1', unit: '1 bowl' },
  'fruit-cup': { photo: '1519996529931-28324d5a630e', unit: '1 cup' },
  croissant: { photo: '1721277000438-488066df7ac8', unit: '1 piece' },
  'pain-choc': { photo: '1623334044303-241021148842', unit: '1 piece' },
  'iced-latte': { photo: '1461023058943-07fcbe16d735', unit: '1 cup' },
  americano: { photo: '1514432324607-a09d9b4aefdd', unit: '1 cup' },
};

const SHOP: Record<string, { photo: string; counter: string; tagline: string; isNew?: 'red' | 'green' }> = {
  noodles: { photo: '1591325418441-ff678baf78ef', counter: 'Red counter', tagline: 'Noodle soup and dumplings', isNew: 'red' },
  greens: { photo: '1512621776951-a57141f2eefd', counter: 'Green counter', tagline: 'Salads and fruit', isNew: 'green' },
  bakery: { photo: '1687978975635-c20d06724c4b', counter: 'Lobby', tagline: 'Pastries baked this morning' },
  cafe: { photo: '1530174883092-c2a7aa3f1cfe', counter: 'Lobby', tagline: 'Coffee, hot and iced' },
};

// Display order: the design's "popular" order, one dish per shop at a time.
const POPULAR = ['chicken-noodle', 'caesar', 'croissant', 'iced-latte', 'dumplings', 'fruit-cup', 'pain-choc', 'americano'];
const rank = (list: string[], id: string) => (list.includes(id) ? list.indexOf(id) : list.length);
export const byPopular = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => rank(POPULAR, a.id) - rank(POPULAR, b.id));
export const byShopOrder = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => rank(Object.keys(SHOP), a.id) - rank(Object.keys(SHOP), b.id));

export const HERO = u('1569718212165-3a8278d5f624', 480);
export const itemPhoto = (id: string, w = 200) => (ITEM[id] ? u(ITEM[id].photo, w) : '');
export const itemUnit = (id: string) => ITEM[id]?.unit ?? '';
export const shopPhoto = (id: string, w = 200) => (SHOP[id] ? u(SHOP[id].photo, w) : '');
export const shopArt = (id: string) => SHOP[id] ?? { photo: '', counter: 'Lobby', tagline: '' };
