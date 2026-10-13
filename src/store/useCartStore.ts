import { create } from 'zustand';
import { Item, CartItem, CartSegment, Customer } from '../types';
// The same allocation and arithmetic the server runs when the bill is saved,
// so the figure on the till is the figure in the ledger.
import { allocateFifo, computeLine, priceSegments, round2, round3, type Allocation } from '../lib/billMath';

type CartBatch = CartItem['batches'][number];

type PaymentMethod = 'cash' | 'upi' | 'credit' | 'split';

interface PaymentAmounts {
  cash: number;
  upi: number;
  credit: number;
}

interface CartTotals {
  subtotal: number;
  tax: number;
  total: number;
}

export interface BillingCart {
  id: string;
  name: string;
  items: CartItem[];
  customer: Customer | null;
  discount: number;
  paymentMethod: PaymentMethod;
  paymentAmounts: PaymentAmounts;
  totals: CartTotals;
}

interface CartState {
  carts: BillingCart[];
  activeCartId: string;
  addBillingTab: () => void;
  setActiveCart: (cartId: string) => void;
  setCartName: (cartId: string, name: string) => void;
  closeBillingTab: (cartId: string) => void;
  /** Add `quantity` of an item, priced from its batches (oldest first). */
  addItem: (item: Item, batches: CartBatch[], quantity?: number) => void;
  removeItem: (itemId: number) => void;
  updateQuantity: (itemId: number, quantity: number) => void;
  /** Re-price a line from a fresh read of the item's batches. */
  setItemBatches: (itemId: number, batches: CartBatch[]) => void;
  setCustomer: (customer: Customer | null) => void;
  setDiscount: (discount: number) => void;
  setPaymentMethod: (method: PaymentMethod) => void;
  setPaymentAmount: (method: 'cash' | 'upi' | 'credit', amount: number) => void;
  clearCart: () => void;
}

/**
 * Price a cart line from the item's batches.
 *
 * Units are taken oldest batch first, each at its batch's selling price, so a
 * line that runs out of last week's stock becomes two segments: the rest of
 * last week's at last week's price, then this week's at this week's. The till
 * cannot change these prices. This is exactly what server.ts does when the
 * bill is saved — the allocation and the arithmetic are the same shared code.
 */
const buildCartLine = (item: Item, batches: CartBatch[], quantity: number): CartItem => {
  const qty = round3(Math.max(0, quantity));
  const available = round3(batches.reduce((acc, batch) => acc + batch.quantity_remaining, 0));
  const defaultPrice = batches[0]?.selling_price ?? item.price;

  const { allocations, shortfall } = allocateFifo(batches, qty);
  // Units beyond what is in stock are priced like the newest stock, so the
  // total stays sensible while the line flags the shortage. The server will
  // not save the bill until the quantity fits.
  const priced: Allocation[] = shortfall > 0
    ? [...allocations, { batch_id: 0, quantity: shortfall, selling_price: batches[batches.length - 1]?.selling_price ?? item.price }]
    : allocations;

  const segments: CartSegment[] = priceSegments(priced).map((segment) => {
    const line = computeLine(item, segment.unit_price, segment.quantity);
    return {
      quantity: line.quantity,
      unit_price: line.unit_price,
      total_amount: line.total_amount,
      taxable_amount: line.taxable_amount,
      sgst_amount: line.sgst_amount,
      cgst_amount: line.cgst_amount,
      igst_amount: line.igst_amount,
    };
  });
  const sum = (key: keyof CartSegment) => round2(segments.reduce((acc, segment) => acc + segment[key], 0));

  return {
    ...item,
    quantity: qty,
    batches,
    available,
    unit_price: segments[0]?.unit_price ?? defaultPrice,
    segments,
    sgst_amount: sum('sgst_amount'),
    cgst_amount: sum('cgst_amount'),
    igst_amount: sum('igst_amount'),
    total_amount: sum('total_amount'),
    taxable_amount: sum('taxable_amount'),
  };
};

/** Rebuild a line after one of its inputs changed. */
const rebuild = (line: CartItem, changes: { batches?: CartBatch[]; quantity?: number }) =>
  buildCartLine(line, changes.batches ?? line.batches, changes.quantity ?? line.quantity);

const createEmptyCart = (index: number): BillingCart => ({
  id: `bill-tab-${Date.now()}-${index}`,
  name: `Bill ${index}`,
  items: [],
  customer: null,
  discount: 0,
  paymentMethod: 'cash',
  paymentAmounts: {
    cash: 0,
    upi: 0,
    credit: 0,
  },
  totals: {
    subtotal: 0,
    tax: 0,
    total: 0,
  },
});

const recalculateCart = (cart: BillingCart): BillingCart => {
  // Sum the per-line taxable values that `buildLine` derived by subtraction,
  // NOT (rounded unit base x quantity). Rounding the unit base and then
  // multiplying lets the client's subtotal drift a paisa per line away from
  // the server's, and once the drift crosses a rupee boundary the floored
  // grand total on screen differs from the one written to the ledger — the
  // cashier collects one amount and the books record another.
  const subtotal = round2(cart.items.reduce((acc, item) => acc + item.taxable_amount, 0));
  const tax = round2(cart.items.reduce((acc, item) => acc + item.sgst_amount + item.cgst_amount + item.igst_amount, 0));
  // Mirrors server.ts: the payable is floored to whole rupees, so the amount
  // on screen is exactly what the bill will record and the customer will pay.
  const total = Math.floor(round2(subtotal + tax - cart.discount));

  const paymentAmounts =
    cart.paymentMethod === 'split'
      ? cart.paymentAmounts
      : {
          cash: cart.paymentMethod === 'cash' ? total : 0,
          upi: cart.paymentMethod === 'upi' ? total : 0,
          credit: cart.paymentMethod === 'credit' ? total : 0,
        };

  return {
    ...cart,
    paymentAmounts,
    totals: {
      subtotal,
      tax,
      total,
    },
  };
};

const updateActiveCart = (
  carts: BillingCart[],
  activeCartId: string,
  updater: (cart: BillingCart) => BillingCart
) => carts.map((cart) => (cart.id === activeCartId ? recalculateCart(updater(cart)) : cart));

export const useCartStore = create<CartState>((set) => {
  const initialCart = createEmptyCart(1);

  return {
    carts: [initialCart],
    activeCartId: initialCart.id,

    addBillingTab: () =>
      set((state) => {
        const newCart = createEmptyCart(state.carts.length + 1);
        return {
          carts: [...state.carts, newCart],
          activeCartId: newCart.id,
        };
      }),

    setActiveCart: (cartId) => set({ activeCartId: cartId }),

    setCartName: (cartId, name) =>
      set((state) => ({
        carts: state.carts.map((cart) =>
          cart.id === cartId
            ? {
                ...cart,
                name: name.trim() || `Bill ${state.carts.findIndex((item) => item.id === cartId) + 1}`,
              }
            : cart
        ),
      })),

    closeBillingTab: (cartId) =>
      set((state) => {
        if (state.carts.length === 1) {
          const replacementCart = createEmptyCart(1);
          return {
            carts: [replacementCart],
            activeCartId: replacementCart.id,
          };
        }

        const closingIndex = state.carts.findIndex((cart) => cart.id === cartId);
        const remainingCarts = state.carts.filter((cart) => cart.id !== cartId);
        const nextActiveCart =
          state.activeCartId === cartId
            ? remainingCarts[Math.max(0, closingIndex - 1)] || remainingCarts[0]
            : remainingCarts.find((cart) => cart.id === state.activeCartId) || remainingCarts[0];

        return {
          carts: remainingCarts,
          activeCartId: nextActiveCart.id,
        };
      }),

    addItem: (item, batches, quantity = 1) =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => {
          const existing = cart.items.find((cartItem) => cartItem.id === item.id);
          if (existing) {
            // Same item again: more of it, priced from the fresh batch read.
            return {
              ...cart,
              items: cart.items.map((cartItem) =>
                cartItem.id === item.id
                  ? rebuild(cartItem, { batches, quantity: cartItem.quantity + quantity })
                  : cartItem
              ),
            };
          }
          return { ...cart, items: [...cart.items, buildCartLine(item, batches, quantity)] };
        }),
      })),

    removeItem: (itemId) =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => ({
          ...cart,
          items: cart.items.filter((item) => item.id !== itemId),
        })),
      })),

    updateQuantity: (itemId, quantity) =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => ({
          ...cart,
          items: cart.items.map((item) => (item.id === itemId ? rebuild(item, { quantity }) : item)),
        })),
      })),

    setItemBatches: (itemId, batches) =>
      set((state) => ({
        // Every open bill tab holding this item, not just the active one: a
        // refresh means the stock moved, wherever the item is waiting.
        carts: state.carts.map((cart) =>
          cart.items.some((item) => item.id === itemId)
            ? recalculateCart({
                ...cart,
                items: cart.items.map((item) => (item.id === itemId ? rebuild(item, { batches }) : item)),
              })
            : cart
        ),
      })),

    setCustomer: (customer) =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => {
          if (customer) {
            return { ...cart, customer };
          }

          const nextCart =
            cart.paymentMethod === 'credit'
              ? { ...cart, customer: null, paymentMethod: 'cash' as PaymentMethod }
              : cart.paymentMethod === 'split'
                ? {
                    ...cart,
                    customer: null,
                    paymentAmounts: {
                      ...cart.paymentAmounts,
                      credit: 0,
                    },
                  }
                : { ...cart, customer: null };

          return nextCart;
        }),
      })),

    setDiscount: (discount) =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => ({
          ...cart,
          discount,
        })),
      })),

    setPaymentMethod: (paymentMethod) =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => ({
          ...cart,
          paymentMethod,
        })),
      })),

    setPaymentAmount: (method, amount) =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => ({
          ...cart,
          paymentMethod: 'split',
          paymentAmounts: {
            ...cart.paymentAmounts,
            [method]: amount,
          },
        })),
      })),

    clearCart: () =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => ({
          ...cart,
          items: [],
          customer: null,
          discount: 0,
          paymentMethod: 'cash',
          paymentAmounts: { cash: 0, upi: 0, credit: 0 },
          totals: { subtotal: 0, tax: 0, total: 0 },
        })),
      })),
  };
});
