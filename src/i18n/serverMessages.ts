/**
 * The server answers in English. On a Kannada screen its messages are matched
 * against these templates and shown in Kannada; anything not listed here shows
 * as the server sent it.
 *
 * Keep the wording identical to server.ts. In the templates, {item} is an item
 * name (shown by its Kannada name), {field} a form field's name, {unit} a unit;
 * every other value is shown as sent.
 */
import { itemLabel, t, unitLabel } from './index';

export const SERVER_MESSAGES = [
  // Checks on a single field ("Phone is required"). Longer forms first.
  '{field} is a published demo password. Choose a different one.',
  '{field} is required',
  '{field} must be a number',
  '{field} must be a valid number',
  '{field} must be a whole number',
  '{field} must be at least {min} characters',
  '{field} must be at least {min}',
  '{field} must be at most {max} characters',
  '{field} must be at most {max}',
  '{field} must be in YYYY-MM-DD format',
  '{field} must be one of: {allowed}',
  '{field} must be text',
  '{field} must contain at least one letter and one number',

  // Signing in and accounts.
  'Invalid username or password',
  'Too many failed attempts. Try again in {minutes} minute(s).',
  'Too many failed sign-in attempts. Try again in {minutes} minute(s).',
  'This account still uses the demo password, so it cannot be used remotely. Sign in at the shop counter and change the password in Settings first.',
  'Account not found',
  'Admin account not found',
  'Cashier not found',
  'Change your own password under My account.',
  'Choose a role: admin or cashier.',
  'Current password is incorrect',
  'Current password is required',
  'Enter a new username or a new password to update.',
  'Enter a new username or password to update',
  'Username already exists',
  'You cannot deactivate your own account.',
  'You cannot delete your own account.',
  "{name} has already used the app (signed in, billed or similar), so the account is part of the shop's records and cannot be deleted. Deactivate it instead: they can no longer sign in, and their records are kept.",

  // Bills.
  'A bill cannot have more than {count} line items',
  'At least one item is required to create a bill',
  'Every item needs a quantity greater than 0',
  'Insufficient stock for {item}: requested {requested}, only {available} available',
  'The price of {item} cannot be changed at billing (it sells as {prices}). Change the selling price in Items → Stock & prices.',
  'Discount cannot exceed the bill subtotal',
  'Payment split (₹{tendered}) does not match the bill total (₹{total})',
  'Credit can only be given to registered customers',
  'Prices or stock changed while this bill was open: it showed ₹{before} but is now ₹{after}. The bill has been refreshed — please check it and save again.',
  'Stock changed while this bill was being processed. Please retry.',
  'Bill not found',
  'Already printed',
  'Print job not found',
  '{bill} put ₹{amount} on credit, but the customer now owes only ₹{owed} — they have already paid some of it. Record the refund as a balance correction on the customer first, then delete the bill.',

  // Customers and credit.
  'A customer with this phone number already exists',
  'Another customer already uses this phone number',
  'Customer not found',
  'Enter the bakery / shop name, or the customer’s name if they have no shop',
  'That change would take the customer’s balance below zero.',
  'This customer has no outstanding credit.',
  'Payment of ₹{amount} is more than the ₹{outstanding} outstanding.',

  // Items and stock.
  'Item not found',
  'Item not found: {id}',
  'Item not found for purchase entry: {id}',
  'Batch not found',
  'Enter a quantity to add or remove',
  'Only {quantity} {unit} of {item} in stock to remove',
  '{item} has never been purchased, so enter the selling price for this stock',
  'This batch is sold out, so there is nothing left to reprice',
  'This item appears on existing bills or purchases and cannot be deleted. Adjust its stock to 0 instead.',

  // Purchases and suppliers.
  '"{item}" is already an item. Pick it from the list instead of adding it again.',
  '"{item}" is on this purchase twice as a new item. Enter it once, or pick it on the second line.',
  'A purchase cannot have more than {count} line items',
  'A purchase line cannot have both IGST and SGST/CGST',
  'A purchase line is either an existing item or a new one, not both',
  'At least one purchase item is required',
  'Every purchase item needs a quantity greater than 0',
  'SGST + CGST cannot exceed 100%',
  'Total GST rate on a purchase line cannot exceed 100%',
  'Amount paid (₹{paid}) is more than the purchase total (₹{total})',
  'A supplier with this name already exists',
  'Another supplier already uses this name',
  'Supplier not found',
  'Purchase not found',
  'Payment not found',
  'Choose the supplier that was paid',
  'That purchase is from a different supplier',
  'The payment date cannot be in the future',
  'This purchase is already fully paid.',
  'Nothing is owed to this supplier.',
  '₹{amount} is more than the ₹{owed} owed on this purchase.',
  '₹{amount} is more than the ₹{owed} owed to this supplier.',

  // General. A bare 401/403 arrives as its status text.
  'Unauthorized',
  'Forbidden',
  'Failed to create local backup',
  'from must be on or before to',
  'Google Drive is not set up on the server yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL to .env and restart.',
  'Malformed JSON in request body',
  'Not found',
  'Nothing to update',
  'Request body too large',
  'Something went wrong. Please try again.',
] as const;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let compiled: Array<{ template: string; names: string[]; pattern: RegExp }> | null = null;

const compile = () =>
  SERVER_MESSAGES.map((template) => {
    const names: string[] = [];
    const source = template
      .split(/(\{\w+\})/)
      .map((piece) => {
        const name = /^\{(\w+)\}$/.exec(piece)?.[1];
        if (!name) return escape(piece);
        names.push(name);
        return '(.+?)';
      })
      .join('');
    return { template, names, pattern: new RegExp(`^${source}$`, 's') };
  });

const showValue = (name: string, value: string) => {
  if (name === 'item') return itemLabel(value);
  if (name === 'field') return t(value);
  if (name === 'unit') return unitLabel(value);
  return value;
};

/** A message from the server, in the language on screen. */
export const translateServerMessage = (message: string): string => {
  if (!message) return message;
  compiled ??= compile();
  for (const { template, names, pattern } of compiled) {
    const match = pattern.exec(message);
    if (!match) continue;
    const vars: Record<string, string> = {};
    names.forEach((name, index) => { vars[name] = showValue(name, match[index + 1]); });
    return t(template, vars);
  }
  return t(message);
};
