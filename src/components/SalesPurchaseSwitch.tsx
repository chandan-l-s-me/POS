import { useSearchParams } from 'react-router-dom';
import { motion } from 'motion/react';
import { ShoppingCart, Truck } from 'lucide-react';
import { cn } from '../lib/utils';

export type TradeView = 'sales' | 'purchases';

const OPTIONS = [
  { id: 'sales', label: 'Sales', icon: ShoppingCart },
  { id: 'purchases', label: 'Purchases', icon: Truck },
] as const;

/**
 * Which side a page shows, kept in the address as ?view=purchases so the menu
 * and other pages can link straight to either. Sales unless purchases are
 * both asked for and allowed (cashiers cannot see purchases).
 */
export const useTradeView = (allowPurchases: boolean) => {
  const [params, setParams] = useSearchParams();
  const view: TradeView = allowPurchases && params.get('view') === 'purchases' ? 'purchases' : 'sales';
  const setView = (next: TradeView) =>
    setParams((current) => {
      const nextParams = new URLSearchParams(current);
      if (next === 'purchases') nextParams.set('view', 'purchases');
      else nextParams.delete('view');
      return nextParams;
    }, { replace: true });
  return [view, setView] as const;
};

/** The Sales | Purchases slider used by History and Reports. */
export const SalesPurchaseSwitch = ({ value, onChange, id }: {
  value: TradeView;
  onChange: (next: TradeView) => void;
  /** Keeps this switch's sliding animation apart from any other on screen. */
  id: string;
}) => (
  <div role="tablist" aria-label="Sales or purchases" className="inline-grid grid-cols-2 gap-1 rounded-2xl border border-gray-200 bg-white p-1 shadow-sm">
    {OPTIONS.map(({ id: optionId, label, icon: Icon }) => {
      const selected = value === optionId;
      return (
        <button
          key={optionId}
          type="button"
          role="tab"
          aria-selected={selected}
          onClick={() => onChange(optionId)}
          className={cn(
            'relative flex items-center justify-center gap-2 rounded-xl px-5 py-2 text-sm font-bold transition-colors',
            selected ? 'text-white' : 'text-gray-600 hover:text-gray-900'
          )}
        >
          {selected && (
            <motion.span
              layoutId={`trade-switch-${id}`}
              className="absolute inset-0 rounded-xl bg-orange-600 shadow-sm"
              transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
            />
          )}
          <Icon size={16} className="relative" />
          <span className="relative">{label}</span>
        </button>
      );
    })}
  </div>
);
