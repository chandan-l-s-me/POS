import { useEffect } from 'react';
import { api } from '../api';
import { useItemNamesStore, useLanguageStore } from '../i18n';
import { useAuthStore } from '../store/useAuthStore';
import { useDataStore } from '../store/useDataStore';

const REFRESH_MS = 60_000;

/**
 * Keeps the Kannada item names loaded while the screen is in Kannada: on
 * sign-in, whenever the catalogue is reloaded (an item was added or renamed),
 * and every minute, since the server translates new items in the background.
 * In English nothing is fetched.
 */
export const useItemNames = () => {
  const token = useAuthStore((state) => state.token);
  const lang = useLanguageStore((state) => state.lang);
  const items = useDataStore((state) => state.items);
  const setNames = useItemNamesStore((state) => state.setNames);

  useEffect(() => {
    if (!token || lang !== 'kn') return;
    let cancelled = false;
    const load = () =>
      api.getKannadaItemNames()
        .then((result) => { if (!cancelled) setNames(result?.names ?? {}); })
        // Names are a nicety: the English ones show until this works.
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, lang, items, setNames]);
};
