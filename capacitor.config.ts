import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android app ("Vyapara Billing"): a native shell around the live site.
 *
 * It opens the Quick Bill screen straight from the shop's server
 * (pos.chandanls.in, through the Cloudflare Tunnel), so every phone always
 * runs the same billing code as the counter and updates the moment the
 * server does — no new APK for a screen change. The shell adds what a
 * browser cannot: classic-Bluetooth receipt printers (BluetoothPrinterPlugin),
 * keeping the screen on while billing, and the back button.
 *
 * Cloudflare Access sign-in happens inside the app on first open, so its
 * domain is allowed to load in the app too.
 */
const config: CapacitorConfig = {
  appId: 'in.chandanls.pos',
  appName: 'Vyapara Billing',
  // Required by Capacitor; the app loads server.url instead.
  webDir: 'dist',
  server: {
    url: 'https://pos.chandanls.in/m',
    allowNavigation: ['pos.chandanls.in', '*.cloudflareaccess.com'],
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
