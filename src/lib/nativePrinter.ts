import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PaperWidth } from './escpos';

/**
 * The Android app's Bluetooth printer.
 *
 * The app (android/) is a native shell around this site. It adds a plugin,
 * BluetoothPrinter (android/app/src/main/java/in/chandanls/pos/
 * BluetoothPrinterPlugin.java), that talks to a paired thermal printer over
 * classic Bluetooth — which a browser cannot — and sends it the ESC/POS bytes
 * built by src/lib/escpos.ts. In a plain browser none of this exists, and the
 * phone screen offers counter printing instead.
 */
interface BluetoothPrinterPlugin {
  /** Printers already paired with the phone in Android's Bluetooth settings. */
  listPaired(): Promise<{ devices: Array<{ name: string; address: string }> }>;
  /** Send raw bytes (base64) to the printer at `address`. */
  print(options: { address: string; data: string }): Promise<void>;
}

const BluetoothPrinter = registerPlugin<BluetoothPrinterPlugin>('BluetoothPrinter');

/** Whether this is running inside the Android app, so a Bluetooth printer can be used. */
export const hasBluetoothPrinting = () =>
  Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('BluetoothPrinter');

export const listPairedPrinters = async () => (await BluetoothPrinter.listPaired()).devices;

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export const printToBluetooth = (address: string, bytes: Uint8Array) =>
  BluetoothPrinter.print({ address, data: toBase64(bytes) });

// --- Where this phone prints -------------------------------------------------
//
// Kept per device: one cashier's phone may carry a Bluetooth printer while
// another sends everything to the counter.

export type PrintMode = 'counter' | 'bluetooth' | 'none';

export interface PrinterSettings {
  mode: PrintMode;
  /** The paired Bluetooth printer, when mode is 'bluetooth'. */
  address?: string;
  name?: string;
  paper: PaperWidth;
}

const STORAGE_KEY = 'quick-bill-printer';

export const loadPrinterSettings = (): PrinterSettings => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && ['counter', 'bluetooth', 'none'].includes(saved.mode)) {
      return { paper: 58, ...saved };
    }
  } catch {
    /* fall through to the default */
  }
  return { mode: 'counter', paper: 58 };
};

export const savePrinterSettings = (settings: PrinterSettings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: the choice lasts for this session only */
  }
};
