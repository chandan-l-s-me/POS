/**
 * Units an item can be bought and sold in.
 *
 * One list for the purchase screen (where items are created), the item edit
 * form and the server's validation of new items, so a unit cannot be spelt
 * two ways. Add a unit here and it is available everywhere.
 */
export const UNIT_OPTIONS = [
  { value: 'piece', label: 'Piece' },
  { value: 'kg', label: 'KG' },
  { value: 'packet', label: 'Packet' },
  { value: 'box', label: 'Box' },
  { value: 'bag', label: 'Bag' },
] as const;

export const UNIT_VALUES = UNIT_OPTIONS.map((unit) => unit.value);

/** Goods sold by weight. */
export const isLooseUnit = (unit: string) => unit.toLowerCase() === 'kg';
