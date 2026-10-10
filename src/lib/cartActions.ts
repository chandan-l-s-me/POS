import { api } from '../api';
import { useCartStore } from '../store/useCartStore';
import { useNoticeStore } from '../store/useNoticeStore';
import type { CartItem, Item, StockBatch } from '../types';
import { round3 } from './billMath';

/**
 * Putting items into the bill, priced first-in first-out.
 *
 * Every add reads the item's batches fresh from the server rather than trusting
 * the catalogue cache, because the price of the next unit depends on which
 * batch it comes from, and another sale may have just used one up. The cart
 * store itself stays synchronous; this is the one place that fetches.
 */

const toCartBatches = (rows: StockBatch[]): CartItem['batches'] =>
  rows.map((batch) => ({
    id: batch.id,
    quantity_remaining: batch.quantity_remaining,
    selling_price: batch.selling_price,
  }));

/** Add `quantity` of an item to the active bill. Resolves to whether it was added. */
export const addItemToCart = async (item: Item, quantity = 1): Promise<boolean> => {
  const notice = useNoticeStore.getState();
  try {
    const res = await api.getItemBatches(item.id);
    const batches = toCartBatches(res?.data ?? []);
    const available = round3(batches.reduce((acc, batch) => acc + batch.quantity_remaining, 0));

    if (available <= 0) {
      notice.show(`${item.name} is out of stock.`, 'warning');
      return false;
    }

    const cart = useCartStore.getState();
    const active = cart.carts.find((entry) => entry.id === cart.activeCartId);
    const alreadyInBill = active?.items.find((line) => line.id === item.id)?.quantity ?? 0;
    if (round3(alreadyInBill + quantity) > available) {
      notice.show(`Only ${available} ${item.metric} of ${item.name} in stock.`, 'warning');
      return false;
    }

    cart.addItem(res.item ? { ...item, ...res.item } : item, batches, quantity);
    return true;
  } catch (err: any) {
    notice.show(err?.message || `Could not add ${item.name}.`, 'error');
    return false;
  }
};

/** Re-read the batches of every item in every open bill, and re-price them. */
export const refreshCartBatches = async (): Promise<void> => {
  const { carts, setItemBatches } = useCartStore.getState();
  const itemIds = new Set(carts.flatMap((cart) => cart.items.map((line) => line.id)));
  await Promise.all(
    [...itemIds].map(async (itemId) => {
      const res = await api.getItemBatches(itemId);
      setItemBatches(itemId, toCartBatches(res?.data ?? []));
    })
  );
};
