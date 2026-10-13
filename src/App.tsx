import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './store/useAuthStore';
import { useDataStore } from './store/useDataStore';
import { useThemeStore } from './store/useThemeStore';
import { api } from './api';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Billing } from './pages/Billing';
import { Items } from './pages/Items';
import { Customers } from './pages/Customers';
import { CustomerPassbook } from './pages/CustomerPassbook';
import { Suppliers } from './pages/Suppliers';
import { History } from './pages/History';
import { Purchases } from './pages/Purchases';
import { PurchaseCredit } from './pages/PurchaseCredit';
import { SalesCredit } from './pages/SalesCredit';
import { Stock } from './pages/Stock';
import { PaymentsDone } from './pages/PaymentsDone';
import { Reports } from './pages/Reports';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { Logs } from './pages/Logs';
import { QuickBill } from './pages/QuickBill';
import { useHsnScanner } from './hooks/useHsnScanner';

const ProtectedRoute = ({ children, roles, bare }: { children: React.ReactNode; roles?: string[]; bare?: boolean }) => {
  const { user, token } = useAuthStore();
  const location = useLocation();

  if (!token || !user) {
    // Remember where they were going, so the phone app lands back on Quick
    // Bill after signing in rather than on the counter's screens.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/billing" replace />;
  }

  // Quick Bill is a full-screen phone layout, without the sidebar.
  return bare ? <>{children}</> : <Layout>{children}</Layout>;
};

/**
 * Everything that needs router context. The scanner hook reads the current
 * route so that it only listens on the billing screen, which means it cannot
 * be mounted above <BrowserRouter> as it used to be.
 */
const AppRoutes = () => {
  useHsnScanner();

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      
      <Route path="/" element={
        <ProtectedRoute roles={['admin']}>
          <Dashboard />
        </ProtectedRoute>
      } />
      
      <Route path="/m" element={
        <ProtectedRoute bare>
          <QuickBill />
        </ProtectedRoute>
      } />

      <Route path="/billing" element={
        <ProtectedRoute>
          <Billing />
        </ProtectedRoute>
      } />
      
      <Route path="/items" element={
        <ProtectedRoute roles={['admin', 'cashier']}>
          <Items />
        </ProtectedRoute>
      } />
      
      <Route path="/customers" element={
        <ProtectedRoute>
          <Customers />
        </ProtectedRoute>
      } />

      <Route path="/customers/:id" element={
        <ProtectedRoute>
          <CustomerPassbook />
        </ProtectedRoute>
      } />

      <Route path="/suppliers" element={
        <ProtectedRoute roles={['admin']}>
          <Suppliers />
        </ProtectedRoute>
      } />
      
      <Route path="/history" element={
        <ProtectedRoute>
          <History />
        </ProtectedRoute>
      } />

      <Route path="/purchases" element={
        <ProtectedRoute roles={['admin']}>
          <Purchases />
        </ProtectedRoute>
      } />

      <Route path="/stock" element={
        <ProtectedRoute>
          <Stock />
        </ProtectedRoute>
      } />

      <Route path="/sales-credit" element={
        <ProtectedRoute>
          <SalesCredit />
        </ProtectedRoute>
      } />

      <Route path="/purchase-credit" element={
        <ProtectedRoute roles={['admin']}>
          <PurchaseCredit />
        </ProtectedRoute>
      } />

      <Route path="/payments-done" element={
        <ProtectedRoute roles={['admin']}>
          <PaymentsDone />
        </ProtectedRoute>
      } />

      <Route path="/reports" element={
        <ProtectedRoute roles={['admin']}>
          <Reports />
        </ProtectedRoute>
      } />

      <Route path="/settings" element={
        <ProtectedRoute roles={['admin']}>
          <Settings />
        </ProtectedRoute>
      } />

      <Route path="/logs" element={
        <ProtectedRoute roles={['admin']}>
          <Logs />
        </ProtectedRoute>
      } />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default function App() {
  const { token } = useAuthStore();
  const { refreshItems, setSettings, setStats } = useDataStore();
  const mode = useThemeStore((state) => state.mode);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, [mode]);

  useEffect(() => {
    if (token) {
      // Fetch initial data
      // Only what the whole shell needs. The customer list used to be pulled
      // in here too, on every page, even though just Billing and Customers
      // read it — so it is now fetched by those pages instead.
      //
      // Note: don't log the responses. These payloads contain phone numbers,
      // addresses, GSTINs and balances; console output persists in the browser
      // and in any screen recording or support session with devtools open.
      // The cache holds up to 1000 items so the billing screen can match a
      // scanned code without a round trip. A shop with more than that is NOT
      // silently truncated: `itemsComplete` goes false and the item picker
      // falls back to server-side search.
      refreshItems().catch(() => console.error('Could not load items.'));
      api.getSettings().then(setSettings).catch(() => {
        console.error('Could not load shop settings.');
      });
      api.getStats().then(setStats).catch(() => {
        /* badge counts are cosmetic — ignore */
      });
    }
  }, [token, refreshItems, setSettings, setStats]);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
