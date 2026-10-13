import React from 'react';

/**
 * A bill as a PDF that looks exactly like the printed one.
 *
 * Renders the same Receipt component the counter prints (thermal or standard,
 * per Settings) off screen, captures it as an image and puts that on a PDF page
 * of the paper's size: 80 mm wide for a thermal receipt (as long as the bill),
 * A4 width for a standard invoice. Used to send the bill on WhatsApp.
 *
 * The libraries are loaded only when a PDF is made, so they cost nothing until
 * someone shares a bill.
 */
export interface BillPdf {
  blob: Blob;
  /** The PDF as base64, for handing to the Android app. */
  base64: string;
  fileName: string;
}

const PAPER_MM = { thermal: 80, standard: 210 } as const;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export const makeBillPdf = async (
  billId: number,
  billNumber: string,
  format: 'thermal' | 'standard'
): Promise<BillPdf> => {
  const [{ createRoot }, { toPng }, { jsPDF }, { Receipt }] = await Promise.all([
    import('react-dom/client'),
    import('html-to-image'),
    import('jspdf'),
    import('../components/Receipt'),
  ]);

  // Off screen, not display:none, so it lays out exactly as when printed.
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'fixed', left: '-10000px', top: '0', width: `${PAPER_MM[format]}mm`, background: '#ffffff', zIndex: '-1',
  });
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The bill took too long to load.')), 15000);
      root.render(
        React.createElement(Receipt, {
          billId,
          layoutOverride: format,
          onDataLoaded: () => { clearTimeout(timeout); resolve(); },
        })
      );
    });
    // Let React paint the loaded bill and the fonts settle.
    await nextFrame();
    await nextFrame();
    await document.fonts?.ready;

    const paper = (host.querySelector('.receipt-paper') as HTMLElement | null) ?? (host.firstElementChild as HTMLElement);
    if (!paper) throw new Error('Could not lay out the bill.');

    const png = await toPng(paper, {
      // Sharp enough to read when zoomed in on a phone.
      pixelRatio: format === 'thermal' ? 3 : 2,
      backgroundColor: '#ffffff',
      // The app uses system fonts; skip fetching font files.
      skipFonts: true,
      cacheBust: false,
    });

    const { width: pxWidth, height: pxHeight } = paper.getBoundingClientRect();
    const widthMm = PAPER_MM[format];
    const heightMm = Math.max(40, (widthMm * pxHeight) / pxWidth);
    const pdf = new jsPDF({
      unit: 'mm',
      format: [widthMm, heightMm],
      orientation: heightMm >= widthMm ? 'portrait' : 'landscape',
      compress: true,
    });
    pdf.setProperties({ title: `Bill ${billNumber}` });
    pdf.addImage(png, 'PNG', 0, 0, widthMm, heightMm, undefined, 'FAST');

    const blob = pdf.output('blob');
    const base64 = pdf.output('datauristring').split(',')[1] ?? '';
    return { blob, base64, fileName: `${billNumber}.pdf` };
  } finally {
    root.unmount();
    host.remove();
  }
};
