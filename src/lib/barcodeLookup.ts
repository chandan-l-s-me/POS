import { api } from '../api';
import { useDataStore } from '../store/useDataStore';
import type { Item } from '../types';
import { findByBarcode, normalizeBarcode } from './barcode';

/**
 * The item a scanned code belongs to, or undefined if none has it.
 *
 * The catalogue copy on this device answers at once. When it has no match the
 * server is asked: the shop may have more items than the copy holds, or the
 * barcode may have just been added on another computer.
 */
export const lookupBarcode = async (code: string): Promise<Item | undefined> => {
  const wanted = normalizeBarcode(code);
  if (!wanted) return undefined;
  const cached = findByBarcode(useDataStore.getState().items, wanted);
  if (cached) return cached;
  try {
    return await api.getItemByBarcode(wanted);
  } catch (error: any) {
    if (error?.status === 404) return undefined;
    throw error;
  }
};
