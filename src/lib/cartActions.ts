import { api } from '../api';
import { useCartStore } from '../store/useCartStore';
import { useNoticeStore } from '../store/useNoticeStore';
import type { Bill, CartItem, Item, StockBatch } from '../types';
import { round3 } from './billMath';
import { t } from '../i18n';

/**
 * Putting items into the bill, priced first-in first-out.
 *
 * Every add reads the item's batches fresh from the server rather than trusting
 * the catalogue cache, because the price of the next unit depends on which
 * batch it comes from, and another sale may have just used one up. The cart
 * store itself stays synchronous; this is the one place that fetches.
 *
 * A tab editing a saved bill reads the batches as if that bill were undone
 * (`excluding_bill`): its own units are on the shelf again for it, as they
 * will be when the edit is saved.
 */

const toCartBatches = (rows: StockBatch[]): CartItem['batches'] =>
  rows.map((batch) => ({
    id: batch.id,
    quantity_remaining: batch.quantity_remaining,
    selling_price: batch.selling_price,
  }));

const activeCart = () => {
  const state = useCartStore.getState();
  return state.carts.find((entry) => entry.id === state.activeCartId);
};

/** Add `quantity` of an item to the active bill. Resolves to whether it was added. */
export const addItemToCart = async (item: Item, quantity = 1): Promise<boolean> => {
  const notice = useNoticeStore.getState();
  try {
    const res = await api.getItemBatches(item.id, { excludingBill: activeCart()?.editing?.billId });
    const batches = toCartBatches(res?.data ?? []);
    const available = round3(batches.reduce((acc, batch) => acc + batch.quantity_remaining, 0));

    if (available <= 0) {
      notice.show(t('{name} is out of stock.', { name: item.name }), 'warning');
      return false;
    }

    const cart = useCartStore.getState();
    const alreadyInBill = activeCart()?.items.find((line) => line.id === item.id)?.quantity ?? 0;
    if (round3(alreadyInBill + quantity) > available) {
      notice.show(t('Only {available} {metric} of {name} in stock.', { available, metric: item.metric, name: item.name }), 'warning');
      return false;
    }

    cart.addItem(res.item ? { ...item, ...res.item } : item, batches, quantity);
    return true;
  } catch (err: any) {
    notice.show(err?.message || t('Could not add {name}.', { name: item.name }), 'error');
    return false;
  }
};

/**
 * Re-read the batches of these items, and re-price them in every open bill
 * holding them — each tab read its own way (an edit tab counts its bill's
 * units as on the shelf).
 */
export const refreshCartItems = async (itemIds: number[]): Promise<void> => {
  const wanted = new Set(itemIds);
  const { carts, setItemBatches } = useCartStore.getState();
  const reads: Array<Promise<void>> = [];
  for (const cart of carts) {
    for (const line of cart.items) {
      if (!wanted.has(line.id)) continue;
      const excludingBill = cart.editing?.billId ?? null;
      reads.push(api.getItemBatches(line.id, { excludingBill }).then((res) => {
        setItemBatches(line.id, toCartBatches(res?.data ?? []), res?.item?.bulk_prices, cart.id);
      }));
    }
  }
  await Promise.all(reads);
};

/** Re-read the batches of every item in every open bill, and re-price them. */
export const refreshCartBatches = async (): Promise<void> => {
  const { carts } = useCartStore.getState();
  await refreshCartItems([...new Set(carts.flatMap((cart) => cart.items.map((line) => line.id)))]);
};

/**
 * Open a saved bill in its own Billing tab to change it: the same items and
 * quantities (one line per item), customer, discount and payment. Saving that
 * tab replaces the bill, keeping its number and date (PUT /api/bills/:id).
 */
export const openBillForEditing = async (bill: Bill): Promise<void> => {
  // A line can be split across batches on the saved bill; the till has one
  // line per item, in the order they were first rung up.
  const quantities = new Map<number, number>();
  for (const line of bill.items ?? []) {
    quantities.set(line.item_id, round3((quantities.get(line.item_id) ?? 0) + line.quantity));
  }
  const [customer, ...lines] = await Promise.all([
    bill.customer_id ? api.getCustomer(bill.customer_id) : Promise.resolve(null),
    ...[...quantities].map(async ([itemId, quantity]) => {
      const res = await api.getItemBatches(itemId, { excludingBill: bill.id });
      return { item: res.item as Item, batches: toCartBatches(res?.data ?? []), quantity };
    }),
  ]);
  useCartStore.getState().startEditingBill({
    billId: bill.id,
    billNumber: bill.bill_number,
    customer,
    discount: bill.discount_amount || 0,
    paymentMethod: bill.payment_method,
    paymentAmounts: { cash: bill.cash_amount || 0, upi: bill.upi_amount || 0, credit: bill.credit_amount || 0 },
    lines,
  });
};
