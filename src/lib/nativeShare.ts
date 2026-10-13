import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * The Android app's "send a PDF to WhatsApp" (BillSharePlugin.java). Absent in
 * a plain browser, where the Web Share API or a download is used instead.
 */
interface BillSharePlugin {
  sharePdf(options: { data: string; fileName: string; phone?: string | null; caption?: string }): Promise<{ via: 'whatsapp' | 'chooser' }>;
}

const BillShare = registerPlugin<BillSharePlugin>('BillShare');

export const hasNativePdfShare = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('BillShare');

export const sharePdfNative = (options: Parameters<BillSharePlugin['sharePdf']>[0]) => BillShare.sharePdf(options);
