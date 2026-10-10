import { create } from 'zustand';

/**
 * A short message for the billing screen — "out of stock", "prices changed".
 *
 * Shown in the page rather than with alert(): a browser dialog blocks the till
 * until dismissed, and Chrome may also drop out of full screen to show one.
 */
export type NoticeTone = 'info' | 'warning' | 'error';

interface NoticeState {
  message: string | null;
  tone: NoticeTone;
  /** Bumped on every show, so the same message twice still re-appears. */
  id: number;
  show: (message: string, tone?: NoticeTone) => void;
  clear: () => void;
}

export const useNoticeStore = create<NoticeState>((set) => ({
  message: null,
  tone: 'info',
  id: 0,
  show: (message, tone = 'warning') => set((state) => ({ message, tone, id: state.id + 1 })),
  clear: () => set({ message: null }),
}));
