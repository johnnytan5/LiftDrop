// Shared by the phone app's screens and the call screen.
import type { Compartment, Item, LedgerRow, Order, Shop } from '../lib/db.ts';

export type Detail = { order: Order; compartments: Compartment[]; ledger: LedgerRow[]; decision: { action: string; charge_compartments: string[]; at: string } | null; lines: { item_id: string; compartment_id: string; qty: number; name: string }[] };
export type Menu = { items: Item[]; shops: Shop[] };
export type Config = { mode: 'mock' | 'sandbox'; clientId: string | null };
export type Cart = Record<string, number>;

export const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
export const DONE = ['captured', 'partially_captured', 'paying_out', 'paid_out'];
export const MAX_SHOPS = 2; // the robot has two compartments, one shop each

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as T;
}

export const cartLines = (cart: Cart) => Object.entries(cart).filter(([, q]) => q > 0).map(([item_id, qty]) => ({ item_id, qty }));
export const cartTotal = (menu: Menu, cart: Cart) => cartLines(cart).reduce((s, l) => s + (menu.items.find((i) => i.id === l.item_id)?.price_cents ?? 0) * l.qty, 0);
export const cartShops = (menu: Menu, cart: Cart) => [...new Set(cartLines(cart).map((l) => menu.items.find((i) => i.id === l.item_id)?.shop_id).filter(Boolean))] as string[];
export const cartCount = (cart: Cart) => cartLines(cart).reduce((s, l) => s + l.qty, 0);

/** The customer-facing status line for an order, also read out by the call line. */
export function headlineOf(d: Detail, shops: Shop[], asked = false, checking = false) {
  const { order, compartments } = d;
  const waitingAt = compartments.find((c) => !c.loaded);
  const shopName = (id: string) => shops.find((s) => s.id === id)?.name ?? id;
  return order.status === 'created' ? 'Waiting for PayPal'
    : order.status === 'held' ? 'Robot is heading to the shops'
    : order.status === 'collecting' ? `Picking up at ${waitingAt ? shopName(waitingAt.shop_id) : 'the shops'}`
    : order.status === 'en_route' ? 'On its way up to you'
    : order.status === 'at_door' ? (asked ? 'One more check' : checking ? 'Checking what you took…' : 'Your robot is at the pantry')
    : DONE.includes(order.status) ? 'Delivered'
    : order.status === 'voided' || order.status === 'returning' ? 'Not delivered, not charged'
    : order.captured_cents > 0 ? 'Charged, payout delayed' : 'Something went wrong. You haven’t been charged.';
}
