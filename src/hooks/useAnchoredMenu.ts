import React, { useLayoutEffect, useState } from 'react';

const MENU_MIN_WIDTH = 340;
const MENU_MAX_HEIGHT = 320;

/**
 * Where to draw a suggestion list for a search box inside a table row.
 *
 * The list is drawn over the page (render it in a portal with the returned
 * style), placed against the box, so the table's scroll box can never clip it.
 * It is at least 340px wide, stays on screen, opens upwards when there is no
 * room below, and follows the box when the page scrolls or resizes.
 *
 * Returns null while closed or while the box is not on the page.
 */
export function useAnchoredMenu(
  open: boolean,
  getAnchor: () => HTMLElement | null | undefined,
  deps: React.DependencyList
): React.CSSProperties | null {
  const [style, setStyle] = useState<React.CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const place = () => {
      const anchor = getAnchor();
      if (!anchor) {
        setStyle(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(rect.width, MENU_MIN_WIDTH);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUp = spaceBelow < MENU_MAX_HEIGHT && rect.top > spaceBelow;
      setStyle({
        position: 'fixed',
        left,
        width,
        maxHeight: Math.min(MENU_MAX_HEIGHT, (openUp ? rect.top : spaceBelow) - 12),
        ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
    // The caller says what moves the box; `getAnchor` is read fresh each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);

  return style;
}
