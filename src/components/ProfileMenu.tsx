import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Moon, Sun, UserCog } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { useDataStore } from '../store/useDataStore';
import { useThemeStore } from '../store/useThemeStore';
import { cn } from '../lib/utils';

/**
 * Who is signed in, at the top right of every screen: their name and role, the
 * shop's item and customer counts, dark mode, their own account settings, and
 * Sign out.
 */
export const ProfileMenu = () => {
  const { user, logout } = useAuthStore();
  const stats = useDataStore((state) => state.stats);
  const { mode: theme, toggleMode: toggleTheme } = useThemeStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // Close on a click or tap elsewhere, on Esc, and whenever the page changes.
  React.useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  React.useEffect(() => setOpen(false), [location.key]);

  if (!user) return null;

  const initial = user.name?.trim()[0]?.toUpperCase() || '?';
  const role = user.role === 'admin' ? 'Admin' : 'Cashier';
  const itemClass = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition-colors';

  const signOut = () => {
    logout();
    navigate('/login');
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn('flex items-center gap-2 rounded-xl p-1 transition-colors hover:bg-gray-100 sm:pr-2.5', open && 'bg-gray-100')}
      >
        {/* Spoken first; the visible name and role follow, so what a screen
            reader says includes what is on screen. */}
        <span className="sr-only">Profile menu: </span>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-100 text-sm font-bold text-orange-600">
          {initial}
        </span>
        <span className="hidden min-w-0 text-left leading-tight sm:block">
          <span className="block max-w-[10rem] truncate text-sm font-semibold text-gray-900">{user.name}</span>
          <span className="block text-xs text-gray-500">{role}</span>
        </span>
        <ChevronDown size={16} className={cn('hidden text-gray-400 transition-transform sm:block', open && 'rotate-180')} />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-gray-200 bg-white p-2 shadow-xl">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-100 font-bold text-orange-600">
              {initial}
            </span>
            <div className="min-w-0">
              <p className="truncate font-semibold text-gray-900">{user.name}</p>
              <p className="truncate text-sm text-gray-500">@{user.username}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 px-3 pb-3">
            <span className={cn(
              'rounded-full px-2 py-0.5 text-xs font-bold',
              user.role === 'admin' ? 'bg-violet-50 text-violet-700' : 'bg-gray-100 text-gray-700'
            )}>
              {role}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">{stats.items} items</span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">{stats.customers} customers</span>
          </div>
          <div className="space-y-0.5 border-t border-gray-100 pt-1.5">
            {/* Stays open on toggle, so the change can be seen and undone. */}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={theme === 'dark'}
              onClick={toggleTheme}
              className={cn(itemClass, 'text-gray-700 hover:bg-gray-100')}
            >
              {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
              Dark mode
              <span className={cn('relative ml-auto h-5 w-9 shrink-0 rounded-full transition-colors', theme === 'dark' ? 'bg-orange-600' : 'bg-gray-300')}>
                <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', theme === 'dark' ? 'left-[18px]' : 'left-0.5')} />
              </span>
            </button>
            {user.role === 'admin' && (
              <button type="button" role="menuitem" onClick={() => navigate('/settings#account')} className={cn(itemClass, 'text-gray-700 hover:bg-gray-100')}>
                <UserCog size={18} /> My account
              </button>
            )}
            <button type="button" role="menuitem" onClick={signOut} className={cn(itemClass, 'text-red-600 hover:bg-red-50')}>
              <LogOut size={18} /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
