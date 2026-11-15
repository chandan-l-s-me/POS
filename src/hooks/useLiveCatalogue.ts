import { useEffect } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store/useAuthStore';
import { useDataStore } from '../store/useDataStore';
import { useCartStore } from '../store/useCartStore';
import { refreshCartItems } from '../lib/cartActions';

/** How often a till asks what changed. Each ask is a few bytes when nothing did. */
export const LIVE_CATALOGUE_MS = 4000;

/**
 * Keep this device's copy of the catalogue up to date with every other till.
 *
 * The copy (useDataStore().items) is what Billing and Quick Bill search and
 * show prices and stock from. It used to load once at sign-in, so an item
 * bought, repriced or sold on another computer did not appear until the app was
 * reloaded. Now, every few seconds while the app is on screen, the server is
 * asked what changed since last time (GET /api/items/changes) and only those
 * items are fetched and merged. Open bills holding a changed item are
 * re-priced from its batches, as on adding it.
 */
export const useLiveCatalogue = () => {
  const token = useAuthStore((state) => state.token);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let busy = false;

    const check = async () => {
      if (stopped || busy || document.visibilityState !== 'visible') return;
      const { itemsSeq, refreshItems, applyItemChanges } = useDataStore.getState();
      // The first load has not finished (or failed): it sets where to start from.
      if (itemsSeq == null) return;
      busy = true;
      try {
        const changes = await api.getItemChanges(itemsSeq);
        if (stopped) return;
        if (changes.reset) {
          await refreshItems();
        } else if (changes.items.length || changes.deleted.length || changes.seq !== itemsSeq) {
          applyItemChanges(changes);
        }
        // Open bills with a changed item: its price and stock may have moved.
        const changedIds = new Set(changes.items.map((item) => item.id));
        const inBills = useCartStore.getState().carts.flatMap((cart) => cart.items.map((line) => line.id));
        const affected = [...new Set(inBills.filter((id) => changes.reset || changedIds.has(id)))];
        if (affected.length) await refreshCartItems(affected);
      } catch {
        // Offline or a server restart: try again next time.
      } finally {
        busy = false;
      }
    };

    const timer = window.setInterval(() => void check(), LIVE_CATALOGUE_MS);
    // Back on screen (phone unlocked, tab switched back): catch up at once.
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [token]);
};
