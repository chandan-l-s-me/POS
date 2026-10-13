import React from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
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
  ClipboardList,
  LogOut, 
  Menu, 
  X,
  Sun,
  Moon,
  Maximize,
  Minimize
} from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { useDataStore } from '../store/useDataStore';
import { useThemeStore } from '../store/useThemeStore';
import { useFullscreen } from '../hooks/useFullscreen';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { PrintStation } from './PrintStation';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { user, logout } = useAuthStore();
  const stats = useDataStore((state) => state.stats);
  const { mode, toggleMode } = useThemeStore();
  const navigate = useNavigate();
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

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard', roles: ['admin'] },
    { to: '/billing', icon: ShoppingCart, label: 'Billing', roles: ['admin', 'cashier'] },
    { to: '/items', icon: Package, label: 'Items', roles: ['admin', 'cashier'] },
    { to: '/stock', icon: Warehouse, label: 'Stock', roles: ['admin', 'cashier'] },
    { to: '/customers', icon: Users, label: 'Customers', roles: ['admin', 'cashier'] },
    { to: '/suppliers', icon: Building2, label: 'Suppliers', roles: ['admin'] },
    { to: '/history', icon: History, label: 'History', roles: ['admin', 'cashier'] },
    { to: '/sales-credit', icon: HandCoins, label: 'Sales Credit', roles: ['admin', 'cashier'] },
    { to: '/purchases', icon: Truck, label: 'Purchases', roles: ['admin'] },
    { to: '/purchase-credit', icon: Wallet, label: 'Purchase Credit', roles: ['admin'] },
    { to: '/payments-done', icon: BadgeCheck, label: 'Payments Done', roles: ['admin'] },
    { to: '/reports', icon: FileSpreadsheet, label: 'Reports', roles: ['admin'] },
    { to: '/settings', icon: SettingsIcon, label: 'Settings', roles: ['admin'] },
    { to: '/logs', icon: ClipboardList, label: 'Logs', roles: ['admin'] },
  ];

  const filteredNavItems = navItems.filter(item => item.roles.includes(user?.role || ''));

  // The menu itself, shared by the docked sidebar and the drawer. `expanded`
  // shows labels; the docked sidebar can collapse to icons only.
  const renderMenu = (expanded: boolean, onClose: () => void, closeIcon: React.ReactNode) => (
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

      {/* Scrolls, so every page stays reachable on a short screen. */}
      <nav className="flex-1 min-h-0 overflow-y-auto px-3 space-y-1">
        {filteredNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={expanded ? undefined : item.label}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-4 px-4 py-2.5 rounded-xl transition-all duration-200 group",
                !expanded && "justify-center px-0",
                isActive
                  ? "bg-orange-50 text-orange-600 font-medium shadow-sm"
                  : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              )
            }
          >
            <item.icon size={21} className="min-w-[21px]" />
            {expanded && <span className="whitespace-nowrap">{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="p-3 border-t border-gray-100 shrink-0">
        <div className={cn("flex items-center gap-3 px-3 py-2", !expanded && "justify-center px-0")}>
          <div className="w-9 h-9 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold shrink-0">
            {user?.name?.[0]?.toUpperCase() || '?'}
          </div>
          {expanded && (
            <div className="overflow-hidden">
              <p className="text-sm font-semibold truncate">{user?.name || 'User'}</p>
              <p className="text-xs text-gray-500 capitalize">{user?.role || 'Role'}</p>
              <div className="flex gap-2 mt-1">
                <span className="text-[10px] bg-gray-100 px-1 rounded text-gray-400">Items: {stats.items}</span>
                <span className="text-[10px] bg-gray-100 px-1 rounded text-gray-400">Cust: {stats.customers}</span>
              </div>
            </div>
          )}
        </div>
        <button
          onClick={handleLogout}
          title={expanded ? undefined : 'Logout'}
          className={cn(
            "w-full flex items-center gap-4 px-4 py-2.5 mt-1 rounded-xl text-red-500 hover:bg-red-50 transition-all",
            !expanded && "justify-center px-0"
          )}
        >
          <LogOut size={21} className="min-w-[21px]" />
          {expanded && <span>Logout</span>}
        </button>
      </div>
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
        {renderMenu(isSidebarOpen, () => setIsSidebarOpen(!isSidebarOpen), isSidebarOpen ? <X size={20} /> : <Menu size={20} />)}
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
              {renderMenu(true, () => setIsDrawerOpen(false), <X size={20} />)}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <PrintStation />
        <header className="h-14 sm:h-16 bg-white border-b border-gray-200 flex items-center justify-between gap-3 px-3 sm:px-6 lg:px-8 shadow-sm shrink-0">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <button
              onClick={() => setIsDrawerOpen(true)}
              className="lg:hidden p-2 -ml-1 rounded-lg text-gray-600 hover:bg-gray-100"
              aria-label="Open menu"
            >
              <Menu size={22} />
            </button>
            <h2 className="truncate text-lg font-semibold text-gray-700">
              {/* Exact match first; then a section's nested pages, so a
                  customer's passbook at /customers/12 is titled Customers. */}
              {(navItems.find(item => item.to === location.pathname) ??
                navItems.find(item => item.to !== '/' && location.pathname.startsWith(`${item.to}/`)))?.label || 'POS'}
            </h2>
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
            <button
              onClick={toggleMode}
              className="p-2.5 rounded-xl bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-900 transition-all"
              aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {mode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div
              className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full flex items-center gap-2"
              title={isOnline ? 'Connected to the till server' : 'No connection to the till server'}
            >
              <div className={cn("w-2 h-2 rounded-full", isOnline ? "bg-green-500 animate-pulse" : "bg-red-500")} />
              <span className="hidden sm:inline">{isOnline ? 'Connected' : 'Offline'}</span>
            </div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-3 sm:p-5 lg:p-8">
          {children}
        </div>
      </main>
    </div>
  );
};
