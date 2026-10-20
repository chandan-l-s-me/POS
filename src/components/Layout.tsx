import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, 
  ShoppingCart, 
  Package, 
  Users, 
  Building2,
  History, 
  Truck,
  Wallet,
  BadgeCheck,
  HandCoins,
  Warehouse,
  FileSpreadsheet,
  Settings as SettingsIcon,
  Menu,
  X,
  Maximize,
  Minimize
} from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { useFullscreen } from '../hooks/useFullscreen';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { PrintStation } from './PrintStation';
import { ProfileMenu } from './ProfileMenu';

interface LayoutProps {
  children: React.ReactNode;
}

interface NavItem {
  to: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  roles: string[];
}

// The menu in three parts: the dashboard, then either the sales or the
// purchase pages (the switch at the top picks which), then the pages both
// sides share.
const OVERVIEW_ITEMS: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', roles: ['admin'] },
];
const SALES_ITEMS: NavItem[] = [
  { to: '/billing', icon: ShoppingCart, label: 'Billing', roles: ['admin', 'cashier'] },
  { to: '/customers', icon: Users, label: 'Customers', roles: ['admin', 'cashier'] },
  { to: '/history', icon: History, label: 'Sales History', roles: ['admin', 'cashier'] },
  { to: '/sales-credit', icon: HandCoins, label: 'Sales Credit', roles: ['admin', 'cashier'] },
];
const PURCHASE_ITEMS: NavItem[] = [
  { to: '/purchases', icon: Truck, label: 'Purchase Entry', roles: ['admin'] },
  { to: '/suppliers', icon: Building2, label: 'Suppliers', roles: ['admin'] },
  { to: '/history?view=purchases', icon: History, label: 'Purchase History', roles: ['admin'] },
  { to: '/purchase-credit', icon: Wallet, label: 'Purchase Credit', roles: ['admin'] },
  { to: '/payments-done', icon: BadgeCheck, label: 'Payments Done', roles: ['admin'] },
];
const SHOP_ITEMS: NavItem[] = [
  { to: '/items', icon: Package, label: 'Items', roles: ['admin', 'cashier'] },
  { to: '/stock', icon: Warehouse, label: 'Stock', roles: ['admin', 'cashier'] },
  { to: '/reports', icon: FileSpreadsheet, label: 'Reports', roles: ['admin'] },
  // The activity log is under Settings → Activity log.
  { to: '/settings', icon: SettingsIcon, label: 'Settings', roles: ['admin'] },
];
const ALL_NAV_ITEMS = [...OVERVIEW_ITEMS, ...SALES_ITEMS, ...PURCHASE_ITEMS, ...SHOP_ITEMS];

type MenuMode = 'sales' | 'purchases';
const MENU_MODES: Array<{ id: MenuMode; label: string; icon: NavItem['icon'] }> = [
  { id: 'sales', label: 'Sales', icon: ShoppingCart },
  { id: 'purchases', label: 'Purchases', icon: Truck },
];
const MENU_MODE_KEY = 'menu-mode';

const readStoredMode = (): MenuMode => {
  try {
    return localStorage.getItem(MENU_MODE_KEY) === 'purchases' ? 'purchases' : 'sales';
  } catch {
    return 'sales';
  }
};

/**
 * Whether the page open is this menu entry's: its own page or one inside it
 * (a customer's passbook is under Customers). Sales and purchase history are
 * one page, told apart by ?view=purchases.
 */
const isOnPage = (item: NavItem, pathname: string, search: string) => {
  const [path, query] = item.to.split('?');
  if (path === '/') return pathname === '/';
  if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;
  if (path === '/history') return (new URLSearchParams(search).get('view') === 'purchases') === Boolean(query);
  return true;
};

/** The half of the menu a page belongs to, or null for a shared page. */
const modeOf = (pathname: string, search: string): MenuMode | null => {
  if (SALES_ITEMS.some((item) => isOnPage(item, pathname, search))) return 'sales';
  if (PURCHASE_ITEMS.some((item) => isOnPage(item, pathname, search))) return 'purchases';
  return null;
};

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const user = useAuthStore((state) => state.user);
  // `window.location.pathname` is read during render and does not subscribe to
  // anything, so the header title below kept showing the previous page's name
  // until some unrelated state change forced a re-render.
  const location = useLocation();
  // Docked sidebar (1024px and wider): expanded or collapsed to icons.
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(true);
  // Narrower screens (tablets, phones): the menu is a drawer, closed by default.
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  React.useEffect(() => setIsDrawerOpen(false), [location.pathname]);
  // The status badge used to be a hardcoded green dot reading "Offline Mode
  // Active" — it said the same thing whether or not the browser could reach
  // anything, which is worse than no indicator on a till that must not keep
  // taking orders it cannot record.
  const [isOnline, setIsOnline] = React.useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  React.useEffect(() => {
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);

  // Restore the cashier's choice after a reload, on their next click or key.
  const { isSupported: canFullscreen, isFullscreen, toggle: toggleFullscreen } =
    useFullscreen({ restoreOnNextGesture: true });

  // F11 is the browser's own fullscreen and works regardless; this is a
  // shortcut that also survives kiosk setups where F11 is captured, and it
  // keeps the button's state in step. A modifier is required so it cannot fire
  // from a barcode scanner or from ordinary typing.
  React.useEffect(() => {
    if (!canFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        void toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canFullscreen, toggleFullscreen]);

  const isAdmin = user?.role === 'admin';
  const allowed = (items: NavItem[]) => items.filter((item) => item.roles.includes(user?.role || ''));

  // Which half of the menu is showing. It follows the page (opening Purchase
  // Credit shows the purchase menu), and the switch flips it without leaving
  // the page. Cashiers have no purchase pages, so they never see the switch.
  const [menuMode, setMenuMode] = React.useState<MenuMode>(
    () => modeOf(location.pathname, location.search) ?? readStoredMode()
  );
  React.useEffect(() => {
    const pageMode = modeOf(location.pathname, location.search);
    if (pageMode) setMenuMode(pageMode);
  }, [location.pathname, location.search]);
  React.useEffect(() => {
    try { localStorage.setItem(MENU_MODE_KEY, menuMode); } catch { /* a convenience only */ }
  }, [menuMode]);
  const shownMode: MenuMode = isAdmin ? menuMode : 'sales';

  const pageTitle =
    (allowed(ALL_NAV_ITEMS).find((item) => isOnPage(item, location.pathname, location.search)) ??
      ALL_NAV_ITEMS.find((item) => isOnPage(item, location.pathname, location.search)))?.label || 'POS';

  const renderLinks = (items: NavItem[], expanded: boolean) =>
    allowed(items).map((item) => (
      <NavLink
        key={item.to}
        // Reports opens on the side the menu is showing.
        to={item.to === '/reports' && shownMode === 'purchases' ? '/reports?view=purchases' : item.to}
        title={expanded ? undefined : item.label}
        className={cn(
          "flex items-center gap-4 px-4 py-2.5 rounded-xl transition-all duration-200 group",
          !expanded && "justify-center px-0",
          isOnPage(item, location.pathname, location.search)
            ? "bg-orange-50 text-orange-600 font-medium shadow-sm"
            : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        )}
      >
        <item.icon size={21} className="min-w-[21px]" />
        {expanded && <span className="whitespace-nowrap">{item.label}</span>}
      </NavLink>
    ));

  const sectionLabel = (label: string, expanded: boolean) =>
    expanded ? (
      <p className="px-4 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wider text-gray-400">{label}</p>
    ) : (
      <div className="mx-3 my-2 border-t border-gray-100" />
    );

  // The menu itself, shared by the docked sidebar and the drawer. `expanded`
  // shows labels; the docked sidebar can collapse to icons only. `instance`
  // keeps the two copies' sliding switch animations apart.
  const renderMenu = (expanded: boolean, onClose: () => void, closeIcon: React.ReactNode, instance: string) => (
    <>
      <div className="px-5 py-4 flex items-center justify-between shrink-0">
        <AnimatePresence mode="wait">
          {expanded && (
            <motion.h1
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-xl font-bold text-orange-600 tracking-tight"
            >
              Vypar<span className="text-gray-900">POS</span>
            </motion.h1>
          )}
        </AnimatePresence>
        <button
          onClick={onClose}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          aria-label={expanded ? 'Collapse menu' : 'Expand menu'}
        >
          {closeIcon}
        </button>
      </div>

      {isAdmin && (
        <div className="px-3 pb-2 shrink-0">
          {expanded ? (
            <div role="radiogroup" aria-label="Menu" className="grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1">
              {MENU_MODES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={shownMode === option.id}
                  onClick={() => setMenuMode(option.id)}
                  className={cn(
                    "relative flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold transition-colors",
                    shownMode === option.id ? "text-white" : "text-gray-500 hover:text-gray-700"
                  )}
                >
                  {/* A solid accent pill, as on History and Reports: a white
                      pill turned into the darkest surface in dark mode and
                      read as the unselected side. */}
                  {shownMode === option.id && (
                    <motion.span
                      layoutId={`menu-mode-${instance}`}
                      className="absolute inset-0 rounded-lg bg-orange-600 shadow-sm"
                      transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
                    />
                  )}
                  <option.icon size={16} className="relative" />
                  <span className="relative">{option.label}</span>
                </button>
              ))}
            </div>
          ) : (
            (() => {
              const current = MENU_MODES.find((option) => option.id === shownMode)!;
              const other = MENU_MODES.find((option) => option.id !== shownMode)!;
              return (
                <button
                  type="button"
                  onClick={() => setMenuMode(other.id)}
                  title={`Showing ${current.label.toLowerCase()} — switch to ${other.label.toLowerCase()}`}
                  aria-label={`Switch menu to ${other.label.toLowerCase()}`}
                  className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200"
                >
                  <current.icon size={18} />
                </button>
              );
            })()
          )}
        </div>
      )}

      {/* Scrolls, so every page stays reachable on a short screen. */}
      <nav className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-1">
        {renderLinks(OVERVIEW_ITEMS, expanded)}
        {sectionLabel(shownMode === 'sales' ? 'Sales' : 'Purchases', expanded)}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={shownMode}
            initial={{ opacity: 0, x: shownMode === 'sales' ? -12 : 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="space-y-1"
          >
            {renderLinks(shownMode === 'sales' ? SALES_ITEMS : PURCHASE_ITEMS, expanded)}
          </motion.div>
        </AnimatePresence>
        {sectionLabel('Shop', expanded)}
        {renderLinks(SHOP_ITEMS, expanded)}
      </nav>
    </>
  );

  return (
    <div className="flex h-screen h-[100dvh] bg-gray-50 text-gray-900 overflow-hidden">
      {/* Docked sidebar: 1024px and wider. */}
      <motion.aside
        initial={false}
        animate={{ width: isSidebarOpen ? 248 : 76 }}
        className="hidden lg:flex bg-white border-r border-gray-200 flex-col shadow-sm z-20 shrink-0"
      >
        {renderMenu(isSidebarOpen, () => setIsSidebarOpen(!isSidebarOpen), isSidebarOpen ? <X size={20} /> : <Menu size={20} />, 'docked')}
      </motion.aside>

      {/* Drawer: narrower screens. */}
      <AnimatePresence>
        {isDrawerOpen && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/30"
              onClick={() => setIsDrawerOpen(false)}
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'tween', duration: 0.2 }}
              className="relative flex w-[272px] max-w-[85vw] flex-col bg-white shadow-xl"
            >
              {renderMenu(true, () => setIsDrawerOpen(false), <X size={20} />, 'drawer')}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <PrintStation />
        {/* Above the page so the profile menu opens over it. */}
        <header className="relative z-30 h-14 sm:h-16 bg-white border-b border-gray-200 flex items-center justify-between gap-3 px-3 sm:px-6 lg:px-8 shadow-sm shrink-0">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <button
              onClick={() => setIsDrawerOpen(true)}
              className="lg:hidden p-2 -ml-1 rounded-lg text-gray-600 hover:bg-gray-100"
              aria-label="Open menu"
            >
              <Menu size={22} />
            </button>
            <h2 className="truncate text-lg font-semibold text-gray-700">{pageTitle}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            {canFullscreen && (
              <button
                onClick={() => void toggleFullscreen()}
                className="p-2.5 rounded-xl bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-900 transition-all"
                aria-label={isFullscreen ? 'Leave full screen' : 'Enter full screen'}
                aria-pressed={isFullscreen}
                title={
                  isFullscreen
                    ? 'Leave full screen (Esc, or Ctrl/Cmd+Shift+F)'
                    : 'Full screen (Ctrl/Cmd+Shift+F)'
                }
              >
                {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
            )}
            <div
              className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full flex items-center gap-2"
              title={isOnline ? 'Connected to the till server' : 'No connection to the till server'}
            >
              <div className={cn("w-2 h-2 rounded-full", isOnline ? "bg-green-500 animate-pulse" : "bg-red-500")} />
              <span className="hidden sm:inline">{isOnline ? 'Connected' : 'Offline'}</span>
            </div>
            <ProfileMenu />
          </div>
        </header>
        <div className="flex-1 overflow-auto p-3 sm:p-5 lg:p-8">
          {children}
        </div>
      </main>
    </div>
  );
};
