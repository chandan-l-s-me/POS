import { create } from 'zustand';
import { Item, CartItem, Customer } from '../types';

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
  addItem: (item: Item, quantity?: number) => void;
  removeItem: (itemId: number) => void;
  updateQuantity: (itemId: number, quantity: number) => void;
  setCustomer: (customer: Customer | null) => void;
  setDiscount: (discount: number) => void;
  setPaymentMethod: (method: PaymentMethod) => void;
  setPaymentAmount: (method: 'cash' | 'upi' | 'credit', amount: number) => void;
  clearCart: () => void;
}

// Round to 2 decimal places, guarding against binary floating-point drift
// (e.g. 0.1 + 0.2) accumulating across tax splits and multi-item totals.
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

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

export const useCartStore = create<CartState>((set, get) => {
  const initialCart = createEmptyCart(1);

  const getTaxBreakdown = (item: Item, totalUnit: number) => {
    if (!item.gst_applicable) {
      return { sgstUnit: 0, cgstUnit: 0, igstUnit: 0, basePriceUnit: totalUnit };
    }

    const itemMode = item.gst_mode || (item.igst_rate ? 'igst' : 'split');
    if (itemMode === 'igst') {
      const igstUnit = (totalUnit * (item.igst_rate || item.gst_rate || 0)) / 100;
      return {
        sgstUnit: 0,
        cgstUnit: 0,
        igstUnit,
        basePriceUnit: totalUnit - igstUnit,
      };
    }

    const sgstUnit = (totalUnit * item.sgst_rate) / 100;
    const cgstUnit = (totalUnit * item.cgst_rate) / 100;
    return {
      sgstUnit,
      cgstUnit,
      igstUnit: 0,
      basePriceUnit: totalUnit - sgstUnit - cgstUnit,
    };
  };

  /**
   * Build a cart line. This mirrors the recomputation in server.ts field for
   * field, including the order of the roundings, so the till and the ledger
   * cannot disagree. Change one and you must change the other.
   */
  const buildLine = (item: Item, totalUnit: number, quantity: number) => {
    const { sgstUnit, cgstUnit, igstUnit } = getTaxBreakdown(item, totalUnit);

    const sgst_amount = round2(sgstUnit * quantity);
    const cgst_amount = round2(cgstUnit * quantity);
    const igst_amount = round2(igstUnit * quantity);
    const total_amount = round2(totalUnit * quantity);
    // Derive the taxable value by subtracting the already-rounded taxes from
    // the already-rounded line total, so that for every line
    //     taxable + tax === total
    // holds exactly and the invoice reconciles.
    const taxable_amount = round2(total_amount - sgst_amount - cgst_amount - igst_amount);

    return {
      quantity,
      sgst_amount,
      cgst_amount,
      igst_amount,
      total_amount,
      taxable_amount,
      // Unit rate consistent with the line taxable value above; this is the
      // figure the server stores in bill_items.price.
      price: quantity > 0 ? round2(taxable_amount / quantity) : 0,
    };
  };

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

    addItem: (item, quantity = 1) =>
      set((state) => ({
        carts: updateActiveCart(state.carts, state.activeCartId, (cart) => {
          const existingItem = cart.items.find((cartItem) => cartItem.id === item.id);

          if (existingItem) {
            const updatedItems = cart.items.map((cartItem) => {
              if (cartItem.id !== item.id) return cartItem;
              const nextQuantity = cartItem.quantity + quantity;
              return { ...cartItem, ...buildLine(cartItem, cartItem.original_price, nextQuantity) };
            });

            return { ...cart, items: updatedItems };
          }

          const totalUnit = item.price;

          return {
            ...cart,
            items: [
              ...cart.items,
              {
                ...item,
                ...buildLine(item, totalUnit, quantity),
                original_price: totalUnit,
              },
            ],
          };
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
          items: cart.items.map((item) =>
            item.id === itemId ? { ...item, ...buildLine(item, item.original_price, quantity) } : item
          ),
        })),
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
