/**
 * What each search box looks in, for src/lib/fuzzy.ts: names (forgiving of a
 * slip, and in Kannada as well as English) and codes (exact).
 */
import { useItemNamesStore } from '../i18n';
import type { SearchFields } from './fuzzy';

const kannadaOf = (name: string | null | undefined) => (name ? useItemNamesStore.getState().names[name] : undefined);

interface SearchableItem {
  name: string;
  hsn_code?: string | null;
  barcode?: string | null;
}

export const ITEM_SEARCH: SearchFields<SearchableItem> = {
  names: (item) => [item.name, kannadaOf(item.name)],
  codes: (item) => [item.hsn_code, item.barcode],
};

interface SearchableCustomer {
  name?: string | null;
  shop_name?: string | null;
  phone?: string | null;
  gstin?: string | null;
}

export const CUSTOMER_SEARCH: SearchFields<SearchableCustomer> = {
  names: (customer) => [customer.shop_name, customer.name, kannadaOf(customer.shop_name), kannadaOf(customer.name)],
  codes: (customer) => [customer.phone, customer.gstin],
};
