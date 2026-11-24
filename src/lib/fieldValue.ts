/**
 * Set a text box's value from outside React, as if it had been typed, so the
 * page's own onChange (and so its state) follows. Through the native setter
 * and an input event: assigning `value` directly is ignored by React.
 *
 * Used when something other than the keyboard has to put a box back as it
 * was: a barcode scanner that typed into the wrong box, or a voice search
 * cancelled by the cashier starting to type.
 */
export const setFieldValue = (field: EventTarget | null, value: string) => {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
  if (field.value === value) return;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};
