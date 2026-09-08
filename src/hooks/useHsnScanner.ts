import { useEffect, useRef } from 'react';
import { useDataStore } from '../store/useDataStore';
import { useCartStore } from '../store/useCartStore';

export const useHsnScanner = () => {
  const { items } = useDataStore();
  const addItem = useCartStore((state) => state.addItem);
  const hsnBuffer = useRef<string>('');
  const lastKeyTime = useRef<number>(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const currentTime = Date.now();

      if (currentTime - lastKeyTime.current > 50) {
        hsnBuffer.current = '';
      }

      if (e.key === 'Enter') {
        if (hsnBuffer.current.length > 1) {
          const item = items.find((i) => i.hsn_code === hsnBuffer.current);
          if (item) {
            addItem(item);
          }
          hsnBuffer.current = '';
        }
      } else if (e.key.length === 1) {
        hsnBuffer.current += e.key;
      }

      lastKeyTime.current = currentTime;
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, addItem]);
};
