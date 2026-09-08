import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/useAuthStore';
import { useDataStore } from './store/useDataStore';
import { useThemeStore } from './store/useThemeStore';
import { api } from './api';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Billing } from './pages/Billing';
import { Items } from './pages/Items';
import { Customers } from './pages/Customers';
import { Suppliers } from './pages/Suppliers';
import { History } from './pages/History';
import { Purchases } from './pages/Purchases';
import { Reports } from './pages/Reports';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';
import { Logs } from './pages/Logs';
import { useHsnScanner } from './hooks/useHsnScanner';

const ProtectedRoute = ({ children, roles }: { children: React.ReactNode; roles?: string[] }) => {
  const { user, token } = useAuthStore();
  
  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/billing" replace />;
  }

  return <Layout>{children}</Layout>;
};

export default function App() {
  const { token } = useAuthStore();
  const { setItems, setCustomers, setSettings } = useDataStore();
  const mode = useThemeStore((state) => state.mode);
  
  useHsnScanner();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, [mode]);

  useEffect(() => {
    if (token) {
      // Fetch initial data
      // Note: don't log the responses. Item, customer and settings payloads
      // contain phone numbers, addresses, GSTINs and outstanding balances;
      // console output persists in the browser and in any screen recording or
      // support session where devtools happen to be open.
      api.getItems().then(setItems).catch(() => {
        console.error('Could not load items.');
      });
      api.getCustomers().then(setCustomers).catch(() => {
        console.error('Could not load customers.');
      });
      api.getSettings().then(setSettings).catch(() => {
        console.error('Could not load shop settings.');
      });
    }
  }, [token, setItems, setCustomers, setSettings]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        
        <Route path="/" element={
          <ProtectedRoute roles={['admin']}>
            <Dashboard />
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
    </BrowserRouter>
  );
}
