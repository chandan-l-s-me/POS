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
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(true);
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
    { to: '/customers', icon: Users, label: 'Customers', roles: ['admin', 'cashier'] },
    { to: '/suppliers', icon: Building2, label: 'Suppliers', roles: ['admin'] },
    { to: '/history', icon: History, label: 'History', roles: ['admin', 'cashier'] },
    { to: '/purchases', icon: Truck, label: 'Purchases', roles: ['admin'] },
    { to: '/reports', icon: FileSpreadsheet, label: 'Reports', roles: ['admin'] },
    { to: '/settings', icon: SettingsIcon, label: 'Settings', roles: ['admin'] },
    { to: '/logs', icon: ClipboardList, label: 'Logs', roles: ['admin'] },
  ];

  const filteredNavItems = navItems.filter(item => item.roles.includes(user?.role || ''));

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 overflow-hidden">
      {/* Sidebar */}
      <motion.aside
        initial={false}
        animate={{ width: isSidebarOpen ? 260 : 80 }}
        className="bg-white border-r border-gray-200 flex flex-col shadow-sm z-20"
      >
        <div className="p-6 flex items-center justify-between">
          <AnimatePresence mode="wait">
            {isSidebarOpen && (
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
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>

        <nav className="flex-1 px-4 space-y-2">
          {filteredNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group",
                  isActive 
                    ? "bg-orange-50 text-orange-600 font-medium shadow-sm" 
                    : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                )
              }
            >
              <item.icon size={22} className={cn("min-w-[22px]")} />
              <AnimatePresence mode="wait">
                {isSidebarOpen && (
                  <motion.span
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    className="whitespace-nowrap"
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-100">
          <div className={cn("flex items-center gap-4 px-4 py-3", !isSidebarOpen && "justify-center")}>
            <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-bold shrink-0">
              {user?.name?.[0]?.toUpperCase() || '?'}
            </div>
            {isSidebarOpen && (
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
            className={cn(
              "w-full flex items-center gap-4 px-4 py-3 mt-2 rounded-xl text-red-500 hover:bg-red-50 transition-all",
              !isSidebarOpen && "justify-center"
            )}
          >
            <LogOut size={22} className="min-w-[22px]" />
            {isSidebarOpen && <span>Logout</span>}
          </button>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-8 shadow-sm shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-gray-700">
              {/* Exact match first; then a section's nested pages, so a
                  customer's passbook at /customers/12 is titled Customers. */}
              {(navItems.find(item => item.to === location.pathname) ??
                navItems.find(item => item.to !== '/' && location.pathname.startsWith(`${item.to}/`)))?.label || 'POS'}
            </h2>
          </div>
          <div className="flex items-center gap-4">
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
              {isOnline ? 'Connected' : 'Offline'}
            </div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-8">
          {children}
        </div>
      </main>
    </div>
  );
};
