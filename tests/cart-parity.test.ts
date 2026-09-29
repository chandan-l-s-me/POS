/**
 * Cart/server parity.
 *
 * The number on the till screen and the number written to the ledger are
 * computed twice, by two different pieces of code: `src/store/useCartStore.ts`
 * in the browser and `server.ts` on the way into SQLite. If they ever disagree
 * the cashier collects one amount and the books record another, and the drawer
 * stops reconciling.
 *
 * This drives the real cart store exactly as the Billing screen does, then
 * posts the same cart and compares what came back.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, startServer, type Client, type TestServer } from './helpers.ts';
import { useCartStore } from '../src/store/useCartStore.ts';
import type { Item } from '../src/types.ts';

let server: TestServer;
let admin: Client;

const makeItem = async (overrides: Partial<Item> & Record<string, unknown> = {}): Promise<Item> => {
  const body = {
    name: `Item ${Math.random().toString(36).slice(2, 10)}`,
    hsn_code: String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
    price: 100,
    metric: 'piece',
    is_loose: false,
    gst_applicable: true,
    gst_mode: 'split' as const,
    gst_rate: 18,
    sgst_rate: 9,
    cgst_rate: 9,
    igst_rate: 0,
    stock_quantity: 100000,
    ...overrides,
  };
  const res = await admin.post('/api/items', body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { id: res.body.id, created_at: '', ...body } as Item;
};

/** Load a cart the way the UI does, and return what the screen would show. */
const ringUp = (lines: Array<{ item: Item; quantity: number }>, discount = 0) => {
  const store = useCartStore.getState();
  store.clearCart();
  for (const { item, quantity } of lines) {
    // The UI adds the item then sets the quantity, so mirror that.
    useCartStore.getState().addItem(item, 1);
    if (quantity !== 1) useCartStore.getState().updateQuantity(item.id, quantity);
  }
  if (discount) useCartStore.getState().setDiscount(discount);

  const state = useCartStore.getState();
  const cart = state.carts.find((c) => c.id === state.activeCartId)!;
  return cart;
};

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
});

after(async () => { await server?.stop(); });

describe('what the till shows is what the ledger records', () => {
  const cases: Array<{ name: string; build: () => Promise<Array<{ item: Item; quantity: number }>>; discount?: number }> = [
    {
      name: 'a single 18% line',
      build: async () => [{ item: await makeItem({ price: 118, gst_rate: 18, sgst_rate: 9, cgst_rate: 9 }), quantity: 3 }],
    },
    {
      name: 'a price with trailing paise at 5%',
      build: async () => [{ item: await makeItem({ price: 33.33, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 }), quantity: 7 }],
    },
    {
      name: 'an awkward price and quantity at 12%',
      build: async () => [{ item: await makeItem({ price: 9.99, gst_rate: 12, sgst_rate: 6, cgst_rate: 6 }), quantity: 13 }],
    },
    {
      name: 'an IGST line',
      build: async () => [{
        item: await makeItem({ price: 249.5, gst_mode: 'igst', gst_rate: 28, sgst_rate: 0, cgst_rate: 0, igst_rate: 28 }),
        quantity: 4,
      }],
    },
    {
      name: 'a GST-exempt line',
      build: async () => [{
        item: await makeItem({ price: 47.5, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 }),
        quantity: 6,
      }],
    },
    {
      name: 'a loose fractional quantity',
      build: async () => [{
        item: await makeItem({ price: 287.77, metric: 'kg', is_loose: true, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 }),
        quantity: 1.35,
      }],
    },
    {
      name: 'a mixed four-line bill',
      build: async () => [
        { item: await makeItem({ price: 118, gst_rate: 18, sgst_rate: 9, cgst_rate: 9 }), quantity: 2 },
        { item: await makeItem({ price: 33.33, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 }), quantity: 3 },
        { item: await makeItem({ price: 47.5, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 }), quantity: 1 },
        { item: await makeItem({ price: 249.5, gst_mode: 'igst', gst_rate: 28, sgst_rate: 0, cgst_rate: 0, igst_rate: 28 }), quantity: 1.5 },
      ],
    },
    {
      name: 'a discounted mixed bill',
      discount: 37,
      build: async () => [
        { item: await makeItem({ price: 199.95, gst_rate: 18, sgst_rate: 9, cgst_rate: 9 }), quantity: 3 },
        { item: await makeItem({ price: 12.75, gst_rate: 12, sgst_rate: 6, cgst_rate: 6 }), quantity: 11 },
      ],
    },
  ];

  for (const testCase of cases) {
    it(`agrees on ${testCase.name}`, async () => {
      const lines = await testCase.build();
      const cart = ringUp(lines, testCase.discount ?? 0);

      const created = await admin.post('/api/bills', {
        items: cart.items.map((line) => ({ id: line.id, quantity: line.quantity })),
        payment_method: 'cash',
        discount_amount: cart.discount,
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));

      const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;

      assert.equal(
        cart.totals.total,
        bill.total_amount,
        `the till showed ₹${cart.totals.total} but the ledger recorded ₹${bill.total_amount}`
      );
      assert.equal(cart.totals.tax, bill.tax_amount, 'GST shown must equal GST recorded');
      assert.equal(cart.totals.subtotal, bill.subtotal_amount, 'subtotal shown must equal subtotal recorded');
      assert.equal(bill.cash_amount, cart.totals.total, 'the drawer records what was displayed');
    });
  }

  it('agrees across a wide sweep of prices, rates and quantities', async () => {
    // The per-paisa rounding paths are where the two implementations can drift,
    // so sweep them rather than trusting a handful of hand-picked numbers.
    const prices = [1, 1.01, 7.77, 9.99, 33.33, 99.95, 100, 123.45, 287.77, 999.99];
    const rates: Array<[number, 'split' | 'igst']> = [[0, 'split'], [5, 'split'], [12, 'split'], [18, 'split'], [28, 'split'], [18, 'igst'], [28, 'igst']];
    const quantities = [1, 2, 3, 7, 13, 0.5, 1.25, 2.75];

    const built: Array<{ item: Item; quantity: number }> = [];
    for (const price of prices) {
      for (const [rate, mode] of rates) {
        built.push({
          item: await makeItem({
            price,
            gst_applicable: rate > 0,
            gst_mode: mode,
            gst_rate: rate,
            sgst_rate: mode === 'split' ? rate / 2 : 0,
            cgst_rate: mode === 'split' ? rate / 2 : 0,
            igst_rate: mode === 'igst' ? rate : 0,
          }),
          quantity: 1,
        });
      }
    }

    let checked = 0;
    const mismatches: string[] = [];
    for (const { item } of built) {
      for (const quantity of quantities) {
        const cart = ringUp([{ item, quantity }]);
        const created = await admin.post('/api/bills', {
          items: [{ id: item.id, quantity }],
          payment_method: 'cash',
        });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
        checked++;
        if (cart.totals.total !== bill.total_amount || cart.totals.tax !== bill.tax_amount || cart.totals.subtotal !== bill.subtotal_amount) {
          mismatches.push(
            `price ${item.price} rate ${item.gst_rate}% ${item.gst_mode} qty ${quantity}: ` +
            `till {sub ${cart.totals.subtotal}, tax ${cart.totals.tax}, total ${cart.totals.total}} vs ` +
            `ledger {sub ${bill.subtotal_amount}, tax ${bill.tax_amount}, total ${bill.total_amount}}`
          );
        }
      }
    }

    assert.ok(checked > 500, `expected a wide sweep, only checked ${checked}`);
    assert.deepEqual(mismatches.slice(0, 10), [], `${mismatches.length} of ${checked} combinations disagreed`);
  });
});
