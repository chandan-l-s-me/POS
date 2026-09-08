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
  const subtotal = round2(cart.items.reduce((acc, item) => acc + item.price * item.quantity, 0));
  const tax = round2(cart.items.reduce((acc, item) => acc + item.sgst_amount + item.cgst_amount + item.igst_amount, 0));
  const total = round2(subtotal + tax - cart.discount);

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
              const totalUnit = cartItem.original_price;
              const { sgstUnit, cgstUnit, igstUnit, basePriceUnit } = getTaxBreakdown(cartItem, totalUnit);

              return {
                ...cartItem,
                quantity: nextQuantity,
                sgst_amount: round2(sgstUnit * nextQuantity),
                cgst_amount: round2(cgstUnit * nextQuantity),
                igst_amount: round2(igstUnit * nextQuantity),
                total_amount: round2(totalUnit * nextQuantity),
                price: round2(basePriceUnit),
              };
            });

            return { ...cart, items: updatedItems };
          }

          const totalUnit = item.price;
          const { sgstUnit, cgstUnit, igstUnit, basePriceUnit } = getTaxBreakdown(item, totalUnit);

          return {
            ...cart,
            items: [
              ...cart.items,
              {
                ...item,
                quantity,
                sgst_amount: round2(sgstUnit * quantity),
                cgst_amount: round2(cgstUnit * quantity),
                igst_amount: round2(igstUnit * quantity),
                total_amount: round2(totalUnit * quantity),
                price: round2(basePriceUnit),
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
          items: cart.items.map((item) => {
            if (item.id !== itemId) return item;
            const totalUnit = item.original_price;
            const { sgstUnit, cgstUnit, igstUnit, basePriceUnit } = getTaxBreakdown(item, totalUnit);

            return {
              ...item,
              quantity,
              sgst_amount: round2(sgstUnit * quantity),
              cgst_amount: round2(cgstUnit * quantity),
              igst_amount: round2(igstUnit * quantity),
              total_amount: round2(totalUnit * quantity),
              price: round2(basePriceUnit),
            };
          }),
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
