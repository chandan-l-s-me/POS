import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ClipboardList, CloudUpload, HardDriveDownload, KeyRound, Languages, Plus, ReceiptText, Save, Store, Trash2, UserCog, Users, X,
} from 'lucide-react';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { ActivityLog } from '../components/ActivityLog';
import { isPrintStation, setPrintStation } from '../components/PrintStation';
import { api } from '../api';
import type { ShopSettings, StaffAccount, User } from '../types';
import { useAuthStore } from '../store/useAuthStore';
import { defaultShopSettings, useDataStore } from '../store/useDataStore';
import { cn, formatDateTimeInIST } from '../lib/utils';
import { t, tn, useItemNamesStore } from '../i18n';
import { tRich } from '../i18n/rich';

/**
 * Admin settings, one section at a time: a menu down the side on a computer,
 * a row of tabs across the top on a phone. The open section is kept in the
 * address (#staff, #backups…) so a reload or a shared link lands on it.
 */

const TABS = [
  { id: 'shop', get label() { return t('Shop details'); }, icon: Store },
  { id: 'bills', get label() { return t('Bills & printing'); }, icon: ReceiptText },
  { id: 'language', get label() { return t('Language'); }, icon: Languages },
  { id: 'staff', get label() { return t('Staff accounts'); }, icon: Users },
  { id: 'backups', get label() { return t('Backups'); }, icon: HardDriveDownload },
  { id: 'account', get label() { return t('My account'); }, icon: UserCog },
  { id: 'logs', get label() { return t('Activity log'); }, icon: ClipboardList },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** The open section is whatever the address says, so links (#account) open it too. */
const tabFromLocation = (hash: string, search: string): TabId => {
  const id = hash.slice(1);
  if (TABS.some((tab) => tab.id === id)) return id as TabId;
  // Back from Google's sign-in page: show how connecting Drive went.
  return new URLSearchParams(search).has('drive') ? 'backups' : 'shop';
};

const SETTINGS_FIELDS = ['shop_name', 'shop_address', 'shop_phone', 'shop_gstin', 'bill_format', 'bill_header', 'bill_footer'] as const;
type SettingsField = (typeof SETTINGS_FIELDS)[number];

type Message = { ok: boolean; text: string } | null;

// --- Building blocks -----------------------------------------------------------

const inputClass =
  'w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100';
const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-orange-700 disabled:opacity-50';
const secondaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50';

const Panel = ({ title, description, action, children }: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section className="rounded-2xl border border-gray-200 bg-white">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-5 py-4 sm:px-6">
      <div className="min-w-0">
        <h2 className="text-base font-bold text-gray-900">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
      </div>
      {action}
    </header>
    <div className="px-5 py-5 sm:px-6">{children}</div>
  </section>
);

const Field = ({ label, hint, className, children }: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <label className={cn('block space-y-1.5', className)}>
    <span className="text-sm font-semibold text-gray-700">{label}</span>
    {children}
    {hint && <span className="block text-xs text-gray-400">{hint}</span>}
  </label>
);

const Notice = ({ message }: { message: Message }) =>
  message ? (
    <p className={cn('rounded-xl px-3.5 py-2.5 text-sm font-medium', message.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>
      {message.text}
    </p>
  ) : null;

const Stat = ({ label, value, tone = 'normal', note }: {
  label: string;
  value: React.ReactNode;
  tone?: 'normal' | 'good' | 'warn' | 'bad';
  note?: React.ReactNode;
}) => (
  <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</p>
    <p className={cn(
      'mt-1.5 font-bold break-all',
      tone === 'good' && 'text-emerald-600',
      tone === 'warn' && 'text-amber-600',
      tone === 'bad' && 'text-red-600',
      tone === 'normal' && 'text-gray-900',
    )}>
      {value}
    </p>
    {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
  </div>
);

// --- Page ----------------------------------------------------------------------

export const Settings = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = tabFromLocation(location.hash, location.search);
  const settings = useDataStore((state) => state.settings);
  const setSettings = useDataStore((state) => state.setSettings);
  const saved = settings.id ? settings : defaultShopSettings;

  const [form, setForm] = useState<ShopSettings>(saved);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<Message>(null);

  useEffect(() => {
    setForm(settings.id ? settings : defaultShopSettings);
  }, [settings]);

  const dirty = SETTINGS_FIELDS.some((field) => (form[field] ?? '') !== (saved[field] ?? ''));

  const choose = (next: TabId) => navigate({ hash: next }, { replace: true });

  const change = (field: SettingsField, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setSaveMessage(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveMessage(null);
    try {
      const updated = await api.updateSettings(form);
      setSettings(updated);
      setForm(updated);
      setSaveMessage({ ok: true, text: t('Saved.') });
    } catch (err: any) {
      setSaveMessage({ ok: false, text: err.message || t('Could not save the settings.') });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setForm(saved);
    setSaveMessage(null);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-gray-900">{t('Settings')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('Shop details, bills, staff and backups. Only admins can open this page.')}</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
        <nav aria-label={t('Settings sections')} className="flex gap-1 overflow-x-auto pb-1 lg:sticky lg:top-4 lg:flex-col lg:overflow-visible lg:pb-0">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => choose(id)}
              aria-current={tab === id ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left text-sm font-semibold transition-colors',
                tab === id ? 'bg-orange-50 text-orange-700 ring-1 ring-orange-200' : 'text-gray-600 hover:bg-gray-100'
              )}
            >
              <Icon size={18} className="shrink-0" />
              <span className="whitespace-nowrap">{label}</span>
              {dirty && (id === 'shop' || id === 'bills') && (
                <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-orange-500" title={t('Unsaved changes')} />
              )}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-5">
          {(tab === 'shop' || tab === 'bills') && (
            <form onSubmit={save} className="space-y-5">
              {tab === 'shop' ? <ShopDetails form={form} onChange={change} /> : <BillLayout form={form} onChange={change} />}

              {/* One save for shop details and bill layout: they are one record. */}
              <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-gray-200 bg-white/95 px-4 py-3 backdrop-blur">
                <div className="mr-auto min-w-0 text-sm">
                  {saveMessage ? (
                    <span className={saveMessage.ok ? 'font-semibold text-emerald-600' : 'font-semibold text-red-600'}>{saveMessage.text}</span>
                  ) : dirty ? (
                    <span className="font-semibold text-orange-600">{t('Unsaved changes')}</span>
                  ) : (
                    <span className="text-gray-400">{t('All changes saved')}</span>
                  )}
                </div>
                <button type="button" onClick={discard} disabled={!dirty || saving} className={secondaryButton}>
                  {t('Discard')}
                </button>
                <button type="submit" disabled={!dirty || saving} className={primaryButton}>
                  <Save size={16} />
                  {saving ? t('Saving…') : t('Save changes')}
                </button>
              </div>
            </form>
          )}
          {tab === 'bills' && <PrintStationSetting />}
          {tab === 'staff' && <StaffAccounts onOpenMyAccount={() => choose('account')} />}
          {tab === 'backups' && (
            <>
              <LocalBackupSetting />
              <GoogleDriveSetting />
            </>
          )}
          {tab === 'account' && <MyAccount />}
          {tab === 'language' && <LanguageSettings />}
          {tab === 'logs' && <ActivityLog />}
        </div>
      </div>
    </div>
  );
};

// --- Shop details and bill layout ------------------------------------------------

type FormSectionProps = { form: ShopSettings; onChange: (field: SettingsField, value: string) => void };

const ShopDetails = ({ form, onChange }: FormSectionProps) => (
  <Panel title={t('Shop details')} description={t('Printed at the top of every bill.')}>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('Shop name')}>
        <input value={form.shop_name} onChange={(e) => onChange('shop_name', e.target.value)} className={inputClass} required />
      </Field>
      <Field label={t('Phone')}>
        <input value={form.shop_phone} onChange={(e) => onChange('shop_phone', e.target.value)} className={inputClass} inputMode="tel" required />
      </Field>
      <Field label={t('Address')} className="sm:col-span-2">
        <textarea
          value={form.shop_address}
          onChange={(e) => onChange('shop_address', e.target.value)}
          className={cn(inputClass, 'min-h-24 resize-y')}
          rows={3}
          required
        />
      </Field>
      <Field label={t('GSTIN')} hint={t('The first two digits are your state code; bills use them for the place of supply.')} className="sm:col-span-2">
        <input value={form.shop_gstin} onChange={(e) => onChange('shop_gstin', e.target.value)} className={cn(inputClass, 'font-mono')} required />
      </Field>
    </div>
  </Panel>
);

const BILL_FORMATS = [
  { id: 'thermal', get label() { return t('Thermal 80 mm'); }, get description() { return t('Narrow roll from a receipt printer.'); } },
  { id: 'standard', get label() { return t('A5 tax invoice'); }, get description() { return t('Full GST tax invoice on A5 paper.'); } },
];

const BillLayout = ({ form, onChange }: FormSectionProps) => (
  <Panel title={t('Bill layout')} description={t('How a printed bill looks.')}>
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold text-gray-700">{t('Receipt style')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {BILL_FORMATS.map((format) => (
            <label
              key={format.id}
              className={cn(
                'flex cursor-pointer gap-3 rounded-xl border p-3.5 transition',
                form.bill_format === format.id ? 'border-orange-400 bg-orange-50 ring-1 ring-orange-200' : 'border-gray-200 hover:bg-gray-50'
              )}
            >
              <input
                type="radio"
                name="bill_format"
                value={format.id}
                checked={form.bill_format === format.id}
                onChange={() => onChange('bill_format', format.id)}
                className="mt-1 accent-orange-600"
              />
              <span>
                <span className="block font-semibold text-gray-900">{format.label}</span>
                <span className="block text-sm text-gray-500">{format.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Header message')} hint={t('Under the shop name.')}>
          <input value={form.bill_header} onChange={(e) => onChange('bill_header', e.target.value)} className={inputClass} required />
        </Field>
        <Field label={t('Footer message')} hint={t('At the bottom, e.g. a thank-you.')}>
          <input value={form.bill_footer} onChange={(e) => onChange('bill_footer', e.target.value)} className={inputClass} required />
        </Field>
      </div>
    </div>
  </Panel>
);

/**
 * Whether this computer prints bills saved on the Quick Bill phone app. Kept
 * per computer (in the browser), so only the counter with the receipt printer
 * turns it on.
 */
const PrintStationSetting = () => {
  const [on, setOn] = useState(isPrintStation);
  const toggle = () => {
    setPrintStation(!on);
    setOn(!on);
  };
  return (
    <Panel
      title={t('Print bills from phones')}
      description={t('Turn on at the counter computer that has the receipt printer. Bills saved on the Quick Bill app then print here.')}
      action={
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t('Print bills from phones on this computer')}
          onClick={toggle}
          className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors', on ? 'bg-emerald-500' : 'bg-gray-300')}
        >
          <span className={cn('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all', on ? 'left-[22px]' : 'left-0.5')} />
        </button>
      }
    >
      <p className="text-sm text-gray-600">
        {on
          ? t('On for this computer. Keep the app open here, on any page. To print without a dialog each time, start Chrome with --kiosk-printing.')
          : t('Off for this computer.')}
      </p>
    </Panel>
  );
};

// --- Staff accounts --------------------------------------------------------------

const ROLE_OPTIONS: Array<{ id: User['role']; label: string; description: string }> = [
  {
    id: 'cashier',
    get label() { return t('Cashier'); },
    get description() { return t('Makes bills and takes payments, at the counter or on the Quick Bill phone app. No settings, reports or purchase costs.'); },
  },
  {
    id: 'admin',
    get label() { return t('Admin'); },
    get description() { return t('Everything a cashier can do, plus settings, staff accounts, purchases, reports and backups.'); },
  },
];

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?';

const StaffAccounts = ({ onOpenMyAccount }: { onOpenMyAccount: () => void }) => {
  const me = useAuthStore((state) => state.user);
  const [accounts, setAccounts] = useState<StaffAccount[] | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [resetFor, setResetFor] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    api.getUsers()
      .then((rows) => setAccounts(Array.isArray(rows) ? rows : []))
      .catch((err: any) => {
        setAccounts([]);
        setMessage({ ok: false, text: err.message || t('Could not load staff accounts.') });
      });
  }, []);

  const update = async (account: StaffAccount, payload: { is_active?: boolean; new_password?: string }, success: string) => {
    setBusyId(account.id);
    setMessage(null);
    try {
      const updated = await api.updateUser(account.id, payload);
      setAccounts((current) => (current || []).map((row) => (row.id === account.id ? { ...row, ...updated } : row)));
      setMessage({ ok: true, text: success });
      return true;
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || t('Could not update the account.') });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = (account: StaffAccount) => {
    const deactivating = account.is_active !== 0;
    if (deactivating && !window.confirm(
      t('Deactivate {name}? They are signed out at once and cannot sign in until reactivated. Their past bills are kept.', { name: account.name })
    )) return;
    void update(
      account,
      { is_active: !deactivating },
      deactivating ? t('{name} deactivated and signed out.', { name: account.name }) : t('{name} reactivated.', { name: account.name })
    );
  };

  // Only an account that never signed in can go; anyone who has used the app
  // is on the shop's records and is deactivated instead.
  const remove = async (account: StaffAccount) => {
    setMessage(null);
    const inUse = (name: string, active: boolean) => ({
      ok: false,
      text: `${t('{name} has already used the app, so the account is part of the shop\'s records and cannot be deleted.', { name })} ` +
        (active ? t('Deactivate it instead: they can no longer sign in, and their records are kept.') : t('It is already deactivated, so they cannot sign in.')),
    });
    if (account.in_use) {
      setMessage(inUse(account.name, account.is_active !== 0));
      return;
    }
    if (!window.confirm(t('Delete the account for {name} (@{username})? This cannot be undone.', { name: account.name, username: account.username }))) return;
    setBusyId(account.id);
    try {
      await api.deleteUser(account.id);
      setAccounts((current) => (current || []).filter((row) => row.id !== account.id));
      if (resetFor === account.id) setResetFor(null);
      setMessage({ ok: true, text: t('Account for {name} deleted.', { name: account.name }) });
    } catch (err: any) {
      if (err.code === 'ACCOUNT_IN_USE') {
        // Used since the list loaded, e.g. they signed in a moment ago.
        setAccounts((current) => (current || []).map((row) => (row.id === account.id ? { ...row, in_use: 1 } : row)));
        setMessage(inUse(account.name, account.is_active !== 0));
      } else {
        setMessage({ ok: false, text: err.message || t('Could not delete the account.') });
      }
    } finally {
      setBusyId(null);
    }
  };

  const submitReset = async (event: React.FormEvent, account: StaffAccount) => {
    event.preventDefault();
    if (await update(account, { new_password: newPassword }, t('Password for {name} reset. They have been signed out.', { name: account.name }))) {
      setResetFor(null);
      setNewPassword('');
    }
  };

  const adminCount = accounts?.filter((a) => a.role === 'admin').length ?? 0;
  const cashierCount = accounts?.filter((a) => a.role === 'cashier').length ?? 0;

  return (
    <>
      {adding && (
        <AddStaffForm
          onCancel={() => setAdding(false)}
          onCreated={(account) => {
            setAccounts((current) => [...(current || []), account]);
            setAdding(false);
            setMessage({ ok: true, text: account.role === 'admin' ? t('Admin account for {name} created.', { name: account.name }) : t('Cashier account for {name} created.', { name: account.name }) });
          }}
        />
      )}

      <Panel
        title={t('Staff accounts')}
        description={accounts ? `${tn(adminCount, '1 admin', '{count} admins')} · ${tn(cashierCount, '1 cashier', '{count} cashiers')}` : t('Everyone who can sign in.')}
        action={!adding && (
          <button type="button" onClick={() => { setAdding(true); setMessage(null); }} className={primaryButton}>
            <Plus size={16} /> {t('Add staff')}
          </button>
        )}
      >
        <div className="space-y-4">
          <Notice message={message} />
          {!accounts ? (
            <p className="text-sm text-gray-400">{t('Loading…')}</p>
          ) : (
            // Flush with the panel's edges, so its rows do not leave an empty
            // double-lined strip under the header.
            <ul className={cn('-mx-5 -mb-5 divide-y divide-gray-100 sm:-mx-6', message ? 'border-t border-gray-100' : '-mt-5')}>
              {accounts.map((account) => {
                const isMe = account.id === me?.id;
                const inactive = account.is_active === 0;
                const busy = busyId === account.id;
                return (
                  <li key={account.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 sm:px-6">
                    <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                      <span className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                        inactive ? 'bg-gray-100 text-gray-400' : account.role === 'admin' ? 'bg-violet-100 text-violet-700' : 'bg-orange-100 text-orange-700'
                      )}>
                        {initials(account.name)}
                      </span>
                      <div className="min-w-0">
                        <p className={cn('truncate font-semibold', inactive ? 'text-gray-400' : 'text-gray-900')}>
                          {account.name}
                          {isMe && <span className="ml-1.5 text-xs font-medium text-gray-400">{t('(you)')}</span>}
                        </p>
                        <p className="truncate text-sm text-gray-500">@{account.username}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'rounded-full px-2.5 py-1 text-xs font-bold',
                        account.role === 'admin' ? 'bg-violet-50 text-violet-700' : 'bg-gray-100 text-gray-700'
                      )}>
                        {account.role === 'admin' ? t('Admin') : t('Cashier')}
                      </span>
                      <span className={cn('inline-flex items-center gap-1.5 text-xs font-semibold', inactive ? 'text-gray-400' : 'text-emerald-600')}>
                        <span className={cn('h-1.5 w-1.5 rounded-full', inactive ? 'bg-gray-300' : 'bg-emerald-500')} />
                        {inactive ? t('Deactivated') : t('Active')}
                      </span>
                    </div>

                    <div className="flex gap-2 sm:ml-auto">
                      {isMe ? (
                        <button type="button" onClick={onOpenMyAccount} className="text-sm font-semibold text-orange-600 hover:underline">
                          {t('Change in My account')}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => { setResetFor(resetFor === account.id ? null : account.id); setNewPassword(''); setMessage(null); }}
                            disabled={busy}
                            className={secondaryButton}
                          >
                            <KeyRound size={14} /> {t('Reset password')}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleActive(account)}
                            disabled={busy}
                            className={secondaryButton}
                          >
                            {inactive ? t('Reactivate') : t('Deactivate')}
                          </button>
                          <button
                            type="button"
                            onClick={() => remove(account)}
                            disabled={busy}
                            title={account.in_use ? t('Already used the app: deactivate instead') : t('Delete this account')}
                            className={cn(secondaryButton, 'text-red-600 hover:bg-red-50', account.in_use && 'opacity-60')}
                          >
                            <Trash2 size={14} /> {t('Delete')}
                          </button>
                        </>
                      )}
                    </div>

                    {resetFor === account.id && (
                      <form onSubmit={(event) => submitReset(event, account)} className="flex basis-full flex-wrap items-end gap-2 rounded-xl bg-gray-50 p-3">
                        <Field label={t('New password for {name}', { name: account.name })} hint={t('At least 10 characters, with a letter and a number. They will be signed out.')} className="min-w-0 flex-1 basis-56">
                          <input
                            type="password"
                            autoFocus
                            autoComplete="new-password"
                            minLength={10}
                            required
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className={inputClass}
                          />
                        </Field>
                        <div className="flex gap-2 pb-5">
                          <button type="button" onClick={() => setResetFor(null)} className={secondaryButton}>{t('Cancel')}</button>
                          <button type="submit" disabled={busy} className={primaryButton}>{busy ? t('Saving…') : t('Set password')}</button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Panel>
    </>
  );
};

const AddStaffForm = ({ onCreated, onCancel }: { onCreated: (account: StaffAccount) => void; onCancel: () => void }) => {
  const [form, setForm] = useState({ name: '', username: '', password: '' });
  // No default: whoever creates the account has to choose.
  const [role, setRole] = useState<User['role'] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!role) {
      setError(t('Choose whether this is a cashier or an admin account.'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onCreated(await api.addUser({ ...form, role }));
    } catch (err: any) {
      setError(err.message || t('Could not create the account.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title={t('Add staff')}
      description={t('A separate sign-in for each person, so every bill shows who made it.')}
      action={
        <button type="button" onClick={onCancel} aria-label={t('Close')} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
          <X size={18} />
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <fieldset>
          <legend className="mb-1.5 text-sm font-semibold text-gray-700">{t('Role')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {ROLE_OPTIONS.map((option) => (
              <label
                key={option.id}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-xl border p-3.5 transition',
                  role === option.id ? 'border-orange-400 bg-orange-50 ring-1 ring-orange-200' : 'border-gray-200 hover:bg-gray-50'
                )}
              >
                <input
                  type="radio"
                  name="role"
                  value={option.id}
                  checked={role === option.id}
                  onChange={() => { setRole(option.id); setError(null); }}
                  className="mt-1 accent-orange-600"
                />
                <span>
                  <span className="block font-semibold text-gray-900">{option.label}</span>
                  <span className="block text-sm text-gray-500">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-400">{t('The role cannot be changed later.')}</p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Full name')}>
            <input value={form.name} onChange={(e) => change('name', e.target.value)} className={inputClass} placeholder={t('e.g. Lohith Kumar')} required />
          </Field>
          <Field label={t('Username')} hint={t('What they type to sign in.')}>
            <input
              value={form.username}
              onChange={(e) => change('username', e.target.value.trim())}
              className={inputClass}
              placeholder={t('e.g. lohith')}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </Field>
          <Field label={t('Password')} hint={t('At least 10 characters, with a letter and a number.')} className="sm:col-span-2">
            <input
              type="password"
              value={form.password}
              onChange={(e) => change('password', e.target.value)}
              className={inputClass}
              autoComplete="new-password"
              minLength={10}
              required
            />
          </Field>
        </div>

        {error && <Notice message={{ ok: false, text: error }} />}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={secondaryButton}>{t('Cancel')}</button>
          <button type="submit" disabled={saving} className={primaryButton}>
            {saving ? t('Creating…') : role === 'admin' ? t('Create admin account') : role === 'cashier' ? t('Create cashier account') : t('Create account')}
          </button>
        </div>
      </form>
    </Panel>
  );
};

// --- My account ------------------------------------------------------------------

/**
 * The language of this device's screens, and how the Kannada item names are
 * coming along. Names are translated on the server in the background; this
 * shows what is still waiting and can start a pass straight away.
 */
const LanguageSettings = () => {
  const [status, setStatus] = useState<{ enabled: boolean; pending: number; total: number; last_error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const setNames = useItemNamesStore((state) => state.setNames);

  const load = async () => {
    const result = await api.getKannadaItemNames();
    setNames(result.names ?? {});
    setStatus({ enabled: result.enabled, pending: result.pending, total: Object.keys(result.names ?? {}).length, last_error: result.last_error });
  };

  useEffect(() => {
    load().catch((err: any) => setMessage({ ok: false, text: err.message || t('Could not load the translation status.') }));
  }, []);

  const translateNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.translateItemNames();
      await load();
      setMessage(result.last_error
        ? { ok: false, text: t('Google Translate could not be reached: {error}', { error: result.last_error }) }
        : { ok: true, text: tn(result.translated, '1 item name translated.', '{count} item names translated.') });
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || t('Could not translate the item names.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Panel title={t('Language')} description={t('The language of the screens on this computer or phone. Each device keeps its own choice.')}>
        <div className="flex flex-wrap items-center gap-4">
          <LanguageSwitch />
          <p className="text-sm text-gray-500">{t('Printed bills stay in English. Item names are typed and searched in English.')}</p>
        </div>
      </Panel>

      <Panel
        title={t('Item names in Kannada')}
        description={t('New items are translated with Google Translate a few seconds after they are saved. A wrong name can be corrected under Items → Edit.')}
        action={status?.enabled && (
          <button type="button" onClick={translateNow} disabled={busy || status.pending === 0} className={secondaryButton}>
            <Languages size={16} /> {busy ? t('Translating…') : t('Translate now')}
          </button>
        )}
      >
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Stat label={t('Translated')} value={status ? status.total.toLocaleString('en-IN') : '…'} tone="good" />
            <Stat label={t('Waiting')} value={status ? status.pending.toLocaleString('en-IN') : '…'} tone={status?.pending ? 'warn' : 'normal'} />
            <Stat
              label={t('Status')}
              value={!status ? '…' : !status.enabled ? t('Turned off') : status.last_error ? t('Not reachable') : t('Working')}
              tone={!status ? 'normal' : !status.enabled || status.last_error ? 'bad' : 'good'}
              note={status?.last_error ? t('Needs the internet. It tries again by itself.') : undefined}
            />
          </div>
          {status && !status.enabled && (
            <p className="text-sm text-gray-500">{tRich('Turned off on the server ({setting} in its {file}).', {
              setting: <span className="font-mono">TRANSLATE_ITEM_NAMES=off</span>,
              file: <span className="font-mono">.env</span>,
            })}</p>
          )}
          <Notice message={message} />
        </div>
      </Panel>
    </div>
  );
};

const MyAccount = () => {
  const user = useAuthStore((state) => state.user);
  const token = useAuthStore((state) => state.token);
  const setAuth = useAuthStore((state) => state.setAuth);
  const [form, setForm] = useState({ username: user?.username || '', current_password: '', new_password: '', confirm_password: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  useEffect(() => {
    setForm((current) => ({ ...current, username: user?.username || '' }));
  }, [user?.username]);

  const change = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setMessage(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (form.new_password && form.new_password !== form.confirm_password) {
      setMessage({ ok: false, text: t('The new password and its confirmation do not match.') });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await api.updateAdminAccount({
        username: form.username,
        current_password: form.current_password,
        new_password: form.new_password,
      });
      // Changing credentials invalidates every previously issued token,
      // including this session's. The server returns a replacement — use it,
      // otherwise the next request 401s and logs the admin straight out.
      if (result.token) setAuth(result.user, result.token);
      else if (token) setAuth(result.user, token);
      setForm({ username: result.user.username, current_password: '', new_password: '', confirm_password: '' });
      setMessage({ ok: true, text: t('Your account was updated.') });
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || t('Could not update your account.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title={t('My account')} description={t('Signed in as {value}. Enter your current password to save any change.', { value: user?.name || user?.username || '' })}>
      <form onSubmit={submit} className="max-w-xl space-y-4">
        <Field label={t('Username')}>
          <input value={form.username} onChange={(e) => change('username', e.target.value)} className={inputClass} autoComplete="username" required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('New password')} hint={t('Leave blank to keep the current one.')}>
            <input type="password" value={form.new_password} onChange={(e) => change('new_password', e.target.value)} className={inputClass} autoComplete="new-password" />
          </Field>
          <Field label={t('Confirm new password')}>
            <input type="password" value={form.confirm_password} onChange={(e) => change('confirm_password', e.target.value)} className={inputClass} autoComplete="new-password" />
          </Field>
        </div>
        <Field label={t('Current password')}>
          <input type="password" value={form.current_password} onChange={(e) => change('current_password', e.target.value)} className={inputClass} autoComplete="current-password" required />
        </Field>
        <Notice message={message} />
        <div className="flex justify-end">
          <button type="submit" disabled={saving} className={primaryButton}>
            <Save size={16} />
            {saving ? t('Saving…') : t('Save')}
          </button>
        </div>
      </form>
    </Panel>
  );
};

// --- Backups ---------------------------------------------------------------------

interface BackupStatus {
  configured: boolean;
  backup_directory: string;
  copy_directory?: string | null;
  auto_backup_hours?: number;
  keep_days?: number;
  backup_count?: number;
  last_backup_at?: string | null;
  last_backup_file?: string | null;
  last_auto_backup_at?: string | null;
}

const LocalBackupSetting = () => {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getLocalBackupStatus()
      .then(setStatus)
      .catch((err: any) => setMessage({ ok: false, text: err.message || t('Could not load the backup status.') }));
  }, []);

  const backupNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.createLocalBackup();
      const drive = result.drive
        ? result.drive.uploaded ? ` ${t('Uploaded to Google Drive.')}` : ` ${t('Google Drive upload failed: {error}', { error: result.drive.error })}`
        : '';
      setMessage({
        ok: !result.drive || result.drive.uploaded,
        text: (result.copiedTo
          ? t('Saved as {fileName}, and copied to {copiedTo}.', { fileName: result.fileName, copiedTo: result.copiedTo })
          : t('Saved as {fileName}.', { fileName: result.fileName })) + drive,
      });
      api.getLocalBackupStatus().then(setStatus).catch(() => {});
      window.dispatchEvent(new Event('drive-status-changed'));
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || t('Could not create the backup.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={t('Backups on this computer')}
      description={t('Each backup is a complete copy of the shop\'s database that can be restored as it is.')}
      action={
        <button type="button" onClick={backupNow} disabled={!status?.configured || busy} className={primaryButton}>
          <HardDriveDownload size={16} />
          {busy ? t('Saving…') : t('Backup now')}
        </button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Stat
            label={t('Last backup')}
            value={status?.last_backup_at ? formatDateTimeInIST(status.last_backup_at) : t('Never')}
            tone={status?.last_backup_at ? 'normal' : 'bad'}
            note={status?.backup_count != null && tn(status.backup_count, '1 backup kept', '{count} backups kept')}
          />
          <Stat
            label={t('Automatic')}
            value={status?.auto_backup_hours ? (status.auto_backup_hours === 24 ? t('Every day') : t('Every {hours} hours', { hours: status.auto_backup_hours })) : t('Off')}
            tone={status?.auto_backup_hours ? 'good' : 'bad'}
            note={status?.auto_backup_hours
              ? `${t('Kept {days} days', { days: status.keep_days })} · ${status.last_auto_backup_at ? t('last {time}', { time: formatDateTimeInIST(status.last_auto_backup_at) }) : t('first one within minutes')}`
              : undefined}
          />
          <Stat
            label={t('Second copy')}
            value={status?.copy_directory || t('Not set')}
            tone={status?.copy_directory ? 'normal' : 'warn'}
            note={status?.copy_directory ? undefined : t('Backups are only on this computer')}
          />
        </div>
        <Notice message={message} />
        <ul className="space-y-1 text-sm text-gray-500">
          <li>{t('• Backups made with Backup now are never deleted; automatic ones are kept for {days} days.', { days: status?.keep_days ?? 30 })}</li>
          <li>
            {tRich('• In case this computer\'s disk fails, set {setting} in the {file} file to a USB drive or a OneDrive / Google Drive folder.', {
              setting: <span className="font-mono text-gray-700">BACKUP_COPY_DIR</span>,
              file: <span className="font-mono text-gray-700">.env</span>,
            })}
          </li>
          {status?.backup_directory && (
            <li>{tRich('• Saved in {folder}', { folder: <span className="font-mono text-gray-700 break-all">{status.backup_directory}</span> })}</li>
          )}
        </ul>
      </div>
    </Panel>
  );
};

interface DriveStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  folder_name: string;
  last_upload_at: string | null;
  last_upload_file: string | null;
  last_error: string | null;
  last_error_at: string | null;
  redirect_uri: string | null;
}

/**
 * Backups to the owner's Google Drive: connect once, then every backup (the
 * daily automatic one and Backup now) is uploaded too. See server/googleDrive.ts.
 */
const GoogleDriveSetting = () => {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const navigate = useNavigate();

  const load = () => api.getGoogleDriveStatus().then(setStatus).catch(() => setStatus(null));

  useEffect(() => {
    void load();
    // Back from Google's sign-in page: say how it went, then tidy the address bar.
    const params = new URLSearchParams(window.location.search);
    const result = params.get('drive');
    if (result === 'connected') setMessage({ ok: true, text: t('Google Drive connected. Every backup will now be uploaded there too.') });
    if (result === 'error') setMessage({ ok: false, text: t('Google Drive was not connected: {reason}', { reason: params.get('reason') || t('unknown error') }) });
    if (result) navigate({ hash: 'backups' }, { replace: true });
    const refresh = () => void load();
    window.addEventListener('drive-status-changed', refresh);
    return () => window.removeEventListener('drive-status-changed', refresh);
  }, []);

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await api.connectGoogleDrive();
      window.location.href = url;
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || t('Could not start connecting.') });
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(t('Stop backing up to Google Drive? Backups already in Drive stay there.'))) return;
    setBusy(true);
    try {
      await api.disconnectGoogleDrive();
      setMessage({ ok: true, text: t('Google Drive disconnected.') });
      await load();
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || t('Could not disconnect.') });
    } finally {
      setBusy(false);
    }
  };

  const failing = status?.last_error && (!status.last_upload_at || (status.last_error_at ?? '') > status.last_upload_at);

  return (
    <Panel
      title={t('Google Drive')}
      description={t('A copy of every backup in your Google Drive, safe even if this computer fails.')}
      action={status?.configured && (
        status.connected ? (
          <button type="button" onClick={disconnect} disabled={busy} className={cn(secondaryButton, 'text-red-600 hover:bg-red-50')}>
            {t('Disconnect')}
          </button>
        ) : (
          <button type="button" onClick={connect} disabled={busy} className={primaryButton}>
            <CloudUpload size={16} />
            {busy ? t('Opening Google…') : t('Connect Google Drive')}
          </button>
        )
      )}
    >
      <div className="space-y-4">
        {!status ? (
          <p className="text-sm text-gray-400">{t('Loading…')}</p>
        ) : !status.configured ? (
          <div className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-gray-700">
            <p className="font-semibold text-gray-900">{t('Not set up on the server yet.')}</p>
            <p className="mt-1">
              {tRich('Add {id}, {secret} and {url} to the server\'s {file} and restart it (the README\'s "Google Drive backup" section has the steps). Then connect here.', {
                id: <span className="font-mono">GOOGLE_CLIENT_ID</span>,
                secret: <span className="font-mono">GOOGLE_CLIENT_SECRET</span>,
                url: <span className="font-mono">PUBLIC_URL</span>,
                file: <span className="font-mono">.env</span>,
              })}
            </p>
          </div>
        ) : status.connected ? (
          <div className="grid gap-3 md:grid-cols-3">
            <Stat label={t('Account')} value={status.email || t('Connected')} tone="good" note={t('Folder "{folder}"', { folder: status.folder_name })} />
            <Stat
              label={t('Last upload')}
              value={status.last_upload_at ? formatDateTimeInIST(status.last_upload_at) : t('Not yet')}
              tone={status.last_upload_at ? 'normal' : 'warn'}
              note={status.last_upload_at ? undefined : t('Press Backup now to send the first one.')}
            />
            <Stat label={t('Status')} value={failing ? status.last_error : t('Working')} tone={failing ? 'bad' : 'good'} />
          </div>
        ) : (
          <p className="text-sm text-gray-600">
            {t('Ready to connect. You will sign in with the Google account whose Drive should hold the backups. The app can only see the files it uploads, nothing else in your Drive.')}
          </p>
        )}
        <Notice message={message} />
      </div>
    </Panel>
  );
};
