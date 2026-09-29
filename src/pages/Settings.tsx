import React, { useEffect, useState } from 'react';
import { Save, Store, ReceiptText, UserPlus, ShieldCheck, HardDriveDownload } from 'lucide-react';
import { api } from '../api';
import { ShopSettings, User } from '../types';
import { useAuthStore } from '../store/useAuthStore';
import { defaultShopSettings, useDataStore } from '../store/useDataStore';

type SettingsField =
  | 'shop_name'
  | 'shop_address'
  | 'shop_phone'
  | 'shop_gstin'
  | 'bill_format'
  | 'bill_header'
  | 'bill_footer';

export const Settings = () => {
  const settings = useDataStore((state) => state.settings);
  const setSettings = useDataStore((state) => state.setSettings);
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const setAuth = useAuthStore((state) => state.setAuth);

  const [formData, setFormData] = useState<ShopSettings>(settings);
  const [adminAccountForm, setAdminAccountForm] = useState({
    username: user?.username || '',
    current_password: '',
    new_password: '',
    confirm_password: '',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [isSavingAdminAccount, setIsSavingAdminAccount] = useState(false);
  const [adminAccountMessage, setAdminAccountMessage] = useState('');
  const [cashiers, setCashiers] = useState<User[]>([]);
  const [cashierForm, setCashierForm] = useState({ name: '', username: '', password: '' });
  const [isCreatingCashier, setIsCreatingCashier] = useState(false);
  const [cashierMessage, setCashierMessage] = useState('');
  const [backupStatus, setBackupStatus] = useState<{ configured: boolean; backup_directory: string } | null>(null);
  const [backupMessage, setBackupMessage] = useState('');
  const [isBackingUp, setIsBackingUp] = useState(false);

  useEffect(() => {
    setFormData(settings.id ? settings : defaultShopSettings);
  }, [settings]);

  useEffect(() => {
    setAdminAccountForm((current) => ({
      ...current,
      username: user?.username || '',
    }));
  }, [user?.username]);

  useEffect(() => {
    api.getCashiers()
      .then((data) => {
        setCashiers(Array.isArray(data) ? data : []);
      })
      .catch((err: any) => {
        setCashierMessage(err.message || 'Failed to load cashiers.');
      });

    api.getLocalBackupStatus()
      .then((data) => setBackupStatus(data))
      .catch((err: any) => setBackupMessage(err.message || 'Failed to load backup status.'));
  }, []);

  const handleChange = (field: SettingsField, value: string) => {
    setFormData((current) => ({ ...current, [field]: value }));
    setSaveMessage('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveMessage('');

    try {
      const updatedSettings = await api.updateSettings(formData);
      setSettings(updatedSettings);
      setFormData(updatedSettings);
      setSaveMessage('Settings saved successfully.');
    } catch (err: any) {
      setSaveMessage(err.message || 'Failed to save settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCashierChange = (field: 'name' | 'username' | 'password', value: string) => {
    setCashierForm((current) => ({ ...current, [field]: value }));
    setCashierMessage('');
  };

  const handleAdminAccountChange = (
    field: 'username' | 'current_password' | 'new_password' | 'confirm_password',
    value: string
  ) => {
    setAdminAccountForm((current) => ({ ...current, [field]: value }));
    setAdminAccountMessage('');
  };

  const handleAdminAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminAccountMessage('');

    if (adminAccountForm.new_password && adminAccountForm.new_password !== adminAccountForm.confirm_password) {
      setAdminAccountMessage('New password and confirm password must match.');
      return;
    }

    setIsSavingAdminAccount(true);

    try {
      const result = await api.updateAdminAccount({
        username: adminAccountForm.username,
        current_password: adminAccountForm.current_password,
        new_password: adminAccountForm.new_password,
      });

      // Changing credentials invalidates every previously issued token,
      // including this session's. The server returns a replacement — use it,
      // otherwise the next request 401s and logs the admin straight out.
      if (result.token) {
        setAuth(result.user, result.token);
      } else if (token) {
        setAuth(result.user, token);
      }

      setAdminAccountForm((current) => ({
        ...current,
        username: result.user.username,
        current_password: '',
        new_password: '',
        confirm_password: '',
      }));
      setAdminAccountMessage('Admin account updated successfully.');
    } catch (err: any) {
      setAdminAccountMessage(err.message || 'Failed to update admin account.');
    } finally {
      setIsSavingAdminAccount(false);
    }
  };

  const handleCashierSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreatingCashier(true);
    setCashierMessage('');

    try {
      const newCashier = await api.addCashier(cashierForm);
      setCashiers((current) => [...current, newCashier].sort((a, b) => a.name.localeCompare(b.name)));
      setCashierForm({ name: '', username: '', password: '' });
      setCashierMessage('Cashier account created successfully.');
    } catch (err: any) {
      setCashierMessage(err.message || 'Failed to create cashier.');
    } finally {
      setIsCreatingCashier(false);
    }
  };

  /**
   * Deactivate/reactivate a cashier, and reset a forgotten password.
   *
   * The server has supported both since cashier accounts existed, and
   * `api.updateCashier` was already defined — but nothing in the app ever
   * called it. There was no way for an admin to revoke access when an employee
   * left: the account kept working, on a machine that takes money, forever.
   */
  const [busyCashierId, setBusyCashierId] = useState<number | null>(null);

  const applyCashierUpdate = async (
    cashier: User & { is_active?: number },
    payload: { is_active?: boolean; new_password?: string },
    successMessage: string
  ) => {
    setBusyCashierId(cashier.id);
    setCashierMessage('');
    try {
      const updated = await api.updateCashier(cashier.id, payload);
      setCashiers((current) => current.map((row) => (row.id === cashier.id ? { ...row, ...updated } : row)));
      setCashierMessage(successMessage);
    } catch (err: any) {
      setCashierMessage(err.message || 'Failed to update cashier.');
    } finally {
      setBusyCashierId(null);
    }
  };

  const handleToggleCashierActive = (cashier: User & { is_active?: number }) => {
    const deactivating = cashier.is_active !== 0;
    if (deactivating && !window.confirm(
      `Deactivate ${cashier.name}? They will be signed out immediately and cannot sign in again until reactivated. Their past bills are kept.`
    )) return;

    return applyCashierUpdate(
      cashier,
      { is_active: !deactivating },
      deactivating ? `${cashier.name} deactivated and signed out.` : `${cashier.name} reactivated successfully.`
    );
  };

  const handleResetCashierPassword = (cashier: User) => {
    const next = window.prompt(
      `New password for ${cashier.name} (at least 10 characters, with a letter and a number):`
    );
    if (next === null) return;
    return applyCashierUpdate(
      cashier,
      { new_password: next },
      `Password for ${cashier.name} reset successfully. They have been signed out.`
    );
  };

  const handleBackupNow = async () => {
    setIsBackingUp(true);
    setBackupMessage('');

    try {
      const result = await api.createLocalBackup();
      setBackupMessage(`Backup saved successfully as ${result.fileName} in ${result.filePath}.`);
    } catch (err: any) {
      setBackupMessage(err.message || 'Failed to create backup.');
    } finally {
      setIsBackingUp(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
        <p className="text-sm font-semibold tracking-[0.2em] uppercase text-orange-600">Admin Settings</p>
        <h1 className="mt-2 text-3xl font-bold text-gray-900">Shop Information & Bill Format</h1>
        <p className="mt-3 text-gray-500 max-w-2xl">
          Update the shop details printed on each receipt. This page is available only to admin users.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-orange-100 text-orange-600 flex items-center justify-center">
              <Store size={22} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Shop Information</h2>
              <p className="text-sm text-gray-500">These details will appear on printed bills.</p>
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Shop Name</span>
              <input
                value={formData.shop_name}
                onChange={(e) => handleChange('shop_name', e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Phone</span>
              <input
                value={formData.shop_phone}
                onChange={(e) => handleChange('shop_phone', e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </label>

            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-gray-700">Shop Address</span>
              <textarea
                value={formData.shop_address}
                onChange={(e) => handleChange('shop_address', e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none min-h-28 resize-y"
                required
              />
            </label>

            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-semibold text-gray-700">GST Number</span>
              <input
                value={formData.shop_gstin}
                onChange={(e) => handleChange('shop_gstin', e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </label>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center">
                <ReceiptText size={22} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">Bill Format</h2>
                <p className="text-sm text-gray-500">Choose how the receipt is laid out.</p>
              </div>
            </div>

            <label className="space-y-2 block">
              <span className="text-sm font-semibold text-gray-700">Receipt Style</span>
              <select
                value={formData.bill_format}
                onChange={(e) => handleChange('bill_format', e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              >
                <option value="thermal">Thermal 80mm</option>
                <option value="standard">Standard Wide</option>
              </select>
            </label>

            <label className="space-y-2 block">
              <span className="text-sm font-semibold text-gray-700">Header Message</span>
              <input
                value={formData.bill_header}
                onChange={(e) => handleChange('bill_header', e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </label>

            <label className="space-y-2 block">
              <span className="text-sm font-semibold text-gray-700">Footer Message</span>
              <input
                value={formData.bill_footer}
                onChange={(e) => handleChange('bill_footer', e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                required
              />
            </label>

            <button
              type="submit"
              disabled={isSaving}
              className="w-full flex items-center justify-center gap-2 py-3 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-200 hover:bg-orange-700 transition-all disabled:opacity-50"
            >
              <Save size={18} />
              {isSaving ? 'Saving...' : 'Save Settings'}
            </button>

            {saveMessage && (
              <p className={`text-sm font-medium ${saveMessage.includes('successfully') ? 'text-green-600' : 'text-red-600'}`}>
                {saveMessage}
              </p>
            )}
          </div>
        </div>
      </form>

      <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
        <form onSubmit={handleAdminAccountSubmit} className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-violet-100 text-violet-700 flex items-center justify-center">
              <ShieldCheck size={22} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Admin Account</h2>
              <p className="text-sm text-gray-500">Change the admin username or password. Current password is required before saving.</p>
            </div>
          </div>

          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">Admin Username</span>
            <input
              value={adminAccountForm.username}
              onChange={(e) => handleAdminAccountChange('username', e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="admin"
              required
            />
          </label>

          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">Current Password</span>
            <input
              type="password"
              value={adminAccountForm.current_password}
              onChange={(e) => handleAdminAccountChange('current_password', e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="Enter current password"
              required
            />
          </label>

          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">New Password</span>
            <input
              type="password"
              value={adminAccountForm.new_password}
              onChange={(e) => handleAdminAccountChange('new_password', e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="Leave blank to keep current password"
            />
          </label>

          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">Confirm New Password</span>
            <input
              type="password"
              value={adminAccountForm.confirm_password}
              onChange={(e) => handleAdminAccountChange('confirm_password', e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="Re-enter new password"
            />
          </label>

          <button
            type="submit"
            disabled={isSavingAdminAccount}
            className="w-full flex items-center justify-center gap-2 py-3 bg-violet-600 text-white font-bold rounded-2xl shadow-lg shadow-violet-200 hover:bg-violet-700 transition-all disabled:opacity-50"
          >
            <ShieldCheck size={18} />
            {isSavingAdminAccount ? 'Updating Account...' : 'Update Admin Account'}
          </button>

          {adminAccountMessage && (
            <p className={`text-sm font-medium ${adminAccountMessage.includes('successfully') ? 'text-green-600' : 'text-red-600'}`}>
              {adminAccountMessage}
            </p>
          )}
        </form>

        <form onSubmit={handleCashierSubmit} className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
              <UserPlus size={22} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Add Cashier</h2>
              <p className="text-sm text-gray-500">Create a separate login for billing staff.</p>
            </div>
          </div>

          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">Name</span>
            <input
              value={cashierForm.name}
              onChange={(e) => handleCashierChange('name', e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="Cashier full name"
              required
            />
          </label>

          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">Username</span>
            <input
              value={cashierForm.username}
              onChange={(e) => handleCashierChange('username', e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="cashier_username"
              required
            />
          </label>

          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">Password</span>
            <input
              type="password"
              value={cashierForm.password}
              onChange={(e) => handleCashierChange('password', e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              placeholder="Create a password"
              required
            />
          </label>

          <button
            type="submit"
            disabled={isCreatingCashier}
            className="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600 text-white font-bold rounded-2xl shadow-lg shadow-emerald-200 hover:bg-emerald-700 transition-all disabled:opacity-50"
          >
            <UserPlus size={18} />
            {isCreatingCashier ? 'Creating...' : 'Create Cashier'}
          </button>

          {cashierMessage && (
            <p className={`text-sm font-medium ${cashierMessage.includes('successfully') ? 'text-green-600' : 'text-red-600'}`}>
              {cashierMessage}
            </p>
          )}
        </form>

        <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-5 lg:col-start-2">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-sky-100 text-sky-700 flex items-center justify-center">
              <ShieldCheck size={22} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Cashier Accounts</h2>
              <p className="text-sm text-gray-500">These users can log in and create bills, but they do not get admin settings access.</p>
            </div>
          </div>

          <div className="space-y-3">
            {cashiers.length === 0 ? (
              <div className="px-4 py-6 rounded-2xl bg-gray-50 text-sm text-gray-500 text-center">
                No cashier accounts created yet.
              </div>
            ) : (
              cashiers.map((cashier) => (
                <div key={cashier.id} className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 rounded-2xl bg-gray-50 border border-gray-100">
                  <div>
                    <p className="font-semibold text-gray-900">{cashier.name}</p>
                    <p className="text-sm text-gray-500">@{cashier.username}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-xs font-semibold uppercase tracking-[0.2em] px-3 py-2 rounded-full ${
                        (cashier as any).is_active === 0
                          ? 'text-red-600 bg-red-50'
                          : 'text-emerald-700 bg-emerald-100'
                      }`}
                    >
                      {(cashier as any).is_active === 0 ? 'Inactive' : 'Active'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleResetCashierPassword(cashier)}
                      disabled={busyCashierId === cashier.id}
                      className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-600 transition-all hover:bg-gray-100 disabled:opacity-40 disabled:pointer-events-none"
                    >
                      Reset Password
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleCashierActive(cashier as any)}
                      disabled={busyCashierId === cashier.id}
                      className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-600 transition-all hover:bg-gray-100 disabled:opacity-40 disabled:pointer-events-none"
                    >
                      {(cashier as any).is_active === 0 ? 'Reactivate' : 'Deactivate'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-sky-100 text-sky-700 flex items-center justify-center">
            <HardDriveDownload size={22} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">Local Disk Backup</h2>
            <p className="text-sm text-gray-500">Admin can manually save a full system backup to the local server disk whenever needed.</p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-400">Status</p>
            <p className={`mt-2 font-bold ${backupStatus?.configured ? 'text-green-600' : 'text-red-600'}`}>
              {backupStatus?.configured ? 'Configured' : 'Not Configured'}
            </p>
          </div>
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4 md:col-span-2">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-400">Backup Folder</p>
            <p className="mt-2 text-sm font-medium text-gray-700 break-all">
              {backupStatus?.backup_directory || 'backups'}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-orange-100 bg-orange-50 p-5 text-sm text-gray-600 space-y-2">
          <p className="font-semibold text-gray-900">Setup methodology</p>
          <p>1. Open admin settings whenever you want a manual backup.</p>
          <p>2. Click the backup button below.</p>
          <p>3. The app writes a full JSON backup into the local `backups/` folder.</p>
          <p>4. You can then copy that file anywhere else for safekeeping.</p>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleBackupNow}
            disabled={!backupStatus?.configured || isBackingUp}
            className="inline-flex items-center gap-2 px-5 py-3 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-200 hover:bg-orange-700 transition-all disabled:opacity-50"
          >
            <HardDriveDownload size={18} />
            {isBackingUp ? 'Saving Backup...' : 'Backup Now'}
          </button>
          {backupStatus?.backup_directory && (
            <p className="text-sm text-gray-500">Saved in: <span className="font-mono">{backupStatus.backup_directory}</span></p>
          )}
        </div>

        {backupMessage && (
          <p className={`text-sm font-medium ${backupMessage.includes('successfully') ? 'text-green-600' : 'text-red-600'}`}>
            {backupMessage}
          </p>
        )}
      </div>
    </div>
  );
};
