import { useEffect } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store/useAuthStore';

/** At most this often when the app keeps coming back to the front. */
const MIN_GAP_MS = 60_000;

/**
 * Check, when the app opens and whenever it comes back on screen, that the
 * signed-in account is still allowed in (POST /api/auth/session).
 *
 * A cashier on the phone app stays signed in across closing and reopening it;
 * this is the check on reopening. A deactivated account, a reset password or
 * an expired session answers 401, and fetchWithAuth signs the app out to the
 * login screen. A stay-signed-in session comes back with a fresh token, so it
 * only ever runs out on a phone left unused for 90 days. Offline, nothing
 * happens: the cashier stays signed in and the check runs next time.
 */
export const useSessionCheck = () => {
  const token = useAuthStore((state) => state.token);

  useEffect(() => {
    if (!token) return;
    let last = 0;
    const check = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      api.checkSession()
        .then((res) => {
          const { token: current, setAuth } = useAuthStore.getState();
          // Signed out (or in as someone else) while this was in flight: leave it.
          if (!current || current !== token) return;
          if (res?.token && res?.user) setAuth(res.user, res.token);
        })
        .catch(() => { /* offline, or a 401 that has already signed out */ });
    };
    check();
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
    // Only on sign-in, not on each renewed token: renewing must not re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!token]);
};
