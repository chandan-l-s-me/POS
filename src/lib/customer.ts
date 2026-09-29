/**
 * How a customer is named, everywhere in the app.
 *
 * This shop knows its customers by their bakery or shop — "Sri Ganesh
 * Bakery" — not by the name of whoever walks in to collect the order. So the
 * shop name is the customer's identity, and the person's name is secondary:
 * who to ask for. A customer with no bakery or shop (an individual) is known
 * by their own name.
 *
 * Every screen that shows a customer goes through these two functions, so the
 * billing picker, the customer list, the invoice and the reports cannot
 * disagree about what a customer is called. The server applies the same rule
 * in SQL for sorting and searching — see CUSTOMER_DISPLAY_SQL in server.ts.
 */

interface NamedCustomer {
  name?: string | null;
  shop_name?: string | null;
}

const clean = (value?: string | null) => (value ?? '').trim();

/** The name to show for a customer: their bakery/shop, else their own name. */
export const customerDisplayName = (customer: NamedCustomer | null | undefined): string => {
  if (!customer) return '';
  return clean(customer.shop_name) || clean(customer.name);
};

/**
 * The person to ask for, shown beneath the display name — or null when there
 * is nothing extra to say: no shop name (so the person's name already *is* the
 * display name), no person's name recorded, or the two are the same.
 */
export const customerContactName = (customer: NamedCustomer | null | undefined): string | null => {
  if (!customer) return null;
  const shop = clean(customer.shop_name);
  const person = clean(customer.name);
  if (!shop || !person) return null;
  if (shop.toLowerCase() === person.toLowerCase()) return null;
  return person;
};

/** The same rule for the flattened customer fields a bill row carries. */
interface BillCustomerFields {
  customer_name?: string | null;
  customer_shop_name?: string | null;
}

const billCustomer = (bill: BillCustomerFields): NamedCustomer => ({
  name: bill.customer_name,
  shop_name: bill.customer_shop_name,
});

/** A bill's customer as shown on screen and on the invoice. */
export const billCustomerDisplayName = (bill: BillCustomerFields, walkInLabel = 'Walk-in'): string =>
  customerDisplayName(billCustomer(bill)) || walkInLabel;

export const billCustomerContactName = (bill: BillCustomerFields): string | null =>
  customerContactName(billCustomer(bill));

/** First letter for an avatar. Safe when the only name recorded is the shop's. */
export const customerInitial = (customer: NamedCustomer | null | undefined): string =>
  customerDisplayName(customer).charAt(0).toUpperCase() || '?';
