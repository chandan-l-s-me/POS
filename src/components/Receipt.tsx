import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Bill } from '../types';
import { useDataStore } from '../store/useDataStore';
import { formatDateInIST, formatDateTimeCompactInIST } from '../lib/utils';
import { billCustomerContactName, billCustomerDisplayName } from '../lib/customer';
import { UNIT_OPTIONS } from '../lib/units';

interface ReceiptProps {
  billId: number;
  onDataLoaded?: () => void;
  layoutOverride?: 'thermal' | 'standard';
}

interface HsnSummaryRow {
  hsn: string;
  taxable: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
}

/** Bills print in English whatever language the screen is in. */
const BILL_LOCALE = 'en-GB';

const formatMoney = (value: number) => value.toFixed(2);

/** Indian digit grouping, as on a tax invoice: 1,23,456.78. */
const formatAmount = (value: number) =>
  value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const formatRate = (value: number) => `${(Math.round(value * 100) / 100).toFixed(2)}%`;

/** Whole counts as they are; weights to the gram, without trailing zeros. */
const formatQuantity = (value: number) =>
  Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);

const UNIT_LABELS: Record<string, string> = Object.fromEntries(
  UNIT_OPTIONS.map((unit) => [unit.value, unit.value === 'piece' ? 'Nos' : unit.label])
);

const formatTimeInIST = (value: string) =>
  formatDateInIST(value, { day: undefined, month: undefined, year: undefined, hour: '2-digit', minute: '2-digit', hour12: true }, BILL_LOCALE);

const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh (New)',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

const getStateFromGstin = (gstin?: string) => {
  const code = (gstin || '').trim().slice(0, 2);
  const name = GST_STATE_CODES[code] || '-';
  return { name, code: code || '-' };
};

const formatPaymentMethod = (method: Bill['payment_method']) => {
  if (method === 'upi') return 'UPI';
  if (method === 'cash') return 'Cash';
  if (method === 'credit') return 'Credit';
  return 'Split';
};

const toWords = (value: number) => {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const convertBelowThousand = (num: number): string => {
    let text = '';
    if (num >= 100) {
      text += `${ones[Math.floor(num / 100)]} Hundred `;
      num %= 100;
    }
    if (num >= 20) {
      text += `${tens[Math.floor(num / 10)]} `;
      num %= 10;
    } else if (num >= 10) {
      text += `${teens[num - 10]} `;
      num = 0;
    }
    if (num > 0) text += `${ones[num]} `;
    return text.trim();
  };

  // Rupees and paise apart. Rounding to whole rupees printed a ₹37.38 tax as
  // "Thirty Seven"; the words must say the same as the figures.
  const totalPaise = Math.round(value * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;

  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const remainder = rupees % 1000;

  const parts = [
    crore ? `${convertBelowThousand(crore)} Crore` : '',
    lakh ? `${convertBelowThousand(lakh)} Lakh` : '',
    thousand ? `${convertBelowThousand(thousand)} Thousand` : '',
    remainder ? convertBelowThousand(remainder) : '',
  ].filter(Boolean);

  const rupeeWords = parts.join(' ').trim() || 'Zero';
  return paise ? `${rupeeWords} and ${convertBelowThousand(paise)} Paise` : rupeeWords;
};

export const Receipt: React.FC<ReceiptProps> = ({ billId, onDataLoaded, layoutOverride }) => {
  const [bill, setBill] = useState<Bill | null>(null);
  const settings = useDataStore((state) => state.settings);

  useEffect(() => {
    if (!billId) return;

    setBill(null);
    api.getBill(billId)
      .then((data) => setBill(data))
      .catch((err) => console.error('Receipt fetch error:', err));
  }, [billId]);

  useEffect(() => {
    if (bill && onDataLoaded) onDataLoaded();
  }, [bill, onDataLoaded]);

  const gstSummary = useMemo(() => {
    return (bill?.items || []).reduce(
      (acc, item) => {
        acc.taxableValue += item.total_amount - item.sgst_amount - item.cgst_amount - (item.igst_amount || 0);
        acc.sgst += item.sgst_amount;
        acc.cgst += item.cgst_amount;
        acc.igst += item.igst_amount || 0;
        return acc;
      },
      { taxableValue: 0, sgst: 0, cgst: 0, igst: 0 }
    );
  }, [bill]);

  if (!bill) {
    return (
      <div className="mx-auto w-[80mm] p-6 text-center font-mono text-xs text-gray-400">
        Loading receipt...
      </div>
    );
  }

  // Use the subtotal stored on the bill at the time of sale. It is the figure
  // the sale was actually rung up against; re-deriving it here (or, worse, as
  // `total - tax + discount`, which folds in the paise the grand total drops
  // when it is floored) is how the printed invoice and the on-screen summary
  // came to disagree. Fall back to the line items only for bills written
  // before the column existed.
  const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const subtotal = round2(bill.subtotal_amount ?? gstSummary.taxableValue);
  const grossTotal = round2(subtotal + bill.tax_amount - bill.discount_amount);
  // bills.total_amount is already the floored, collected figure.
  const roundedTotal = bill.total_amount;
  const roundOff = round2(roundedTotal - grossTotal);
  // The shop's state comes from its own GSTIN, not a hardcoded one. This was
  // pinned to Karnataka, so every invoice a shop in any other state printed
  // declared the wrong place of supply.
  const shopState = getStateFromGstin(settings.shop_gstin);
  const customerState = getStateFromGstin(bill.customer_gstin);

  const lineRows = (bill.items || []).map((item) => {
    const igst = item.igst_amount || 0;
    const taxable = item.total_amount - item.sgst_amount - item.cgst_amount - igst;
    const totalTax = item.sgst_amount + item.cgst_amount + igst;
    const qty = item.quantity || 0;
    const rate = qty > 0 ? taxable / qty : 0;
    // What the buyer paid per unit, GST included.
    const unitPrice = item.unit_price ?? (qty > 0 ? item.total_amount / qty : 0);
    // The slab the line was charged at. Working it back from the rounded
    // amounts printed rates like 2.52% for a 2.5% slab, so that is only a
    // fallback for a bill that arrives without its rates.
    const derived = (amount: number) => (taxable > 0 ? (amount / taxable) * 100 : 0);
    const cgstRate = item.cgst_rate ?? derived(item.cgst_amount);
    const sgstRate = item.sgst_rate ?? derived(item.sgst_amount);
    const igstRate = item.igst_rate ?? derived(igst);
    return {
      item,
      taxable,
      totalTax,
      rate,
      unitPrice,
      cgstRate,
      sgstRate,
      igstRate,
    };
  });

  const hsnSummary = lineRows.reduce<Record<string, HsnSummaryRow>>((acc, row) => {
    const hsn = row.item.hsn_code || '-';
    const key = `${hsn}-${row.cgstRate.toFixed(2)}-${row.sgstRate.toFixed(2)}-${row.igstRate.toFixed(2)}`;
    if (!acc[key]) {
      acc[key] = {
        hsn,
        taxable: 0,
        cgstRate: row.cgstRate,
        cgstAmount: 0,
        sgstRate: row.sgstRate,
        sgstAmount: 0,
        igstRate: row.igstRate,
        igstAmount: 0,
      };
    }
    acc[key].taxable += row.taxable;
    acc[key].cgstAmount += row.item.cgst_amount;
    acc[key].sgstAmount += row.item.sgst_amount;
    acc[key].igstAmount += row.item.igst_amount || 0;
    return acc;
  }, {});

  const taxAmountInWords = toWords(bill.tax_amount);
  const hsnRows: HsnSummaryRow[] = Object.values(hsnSummary);
  const activeFormat = layoutOverride || settings.bill_format;

  if (activeFormat === 'standard') {
    const hasIgst = gstSummary.igst > 0;
    const unitOf = (metric: string) => UNIT_LABELS[metric] || metric;
    // One unit across the bill: the quantities add up to something meaningful.
    const units = new Set(lineRows.map((row) => row.item.metric));
    const totalQuantity = units.size === 1
      ? `${formatQuantity(lineRows.reduce((sum, row) => sum + (row.item.quantity || 0), 0))} ${unitOf([...units][0])}`
      : '';
    const paymentDetail = bill.payment_method === 'split'
      ? [
          bill.cash_amount > 0 ? `Cash ${formatAmount(bill.cash_amount)}` : '',
          bill.upi_amount > 0 ? `UPI ${formatAmount(bill.upi_amount)}` : '',
          bill.credit_amount > 0 ? `Credit ${formatAmount(bill.credit_amount)}` : '',
        ].filter(Boolean).join(' + ')
      : '';
    const contactName = billCustomerContactName(bill);
    // Without the buyer's GSTIN the sale is to an unregistered buyer, supplied
    // in the shop's own state.
    const placeOfSupply = bill.customer_gstin ? customerState : shopState;

    return (
      <div className="receipt-paper invoice-a5">
        {/* Bills print on A5. Only rendered with this layout, so a thermal
            receipt keeps the printer's own page size. */}
        <style>{'@page { size: A5 portrait; margin: 6mm; }'}</style>
        <p className="invoice-a5__title">Tax Invoice</p>

        <div className="invoice-a5__box">
          <div className="invoice-a5__head">
            <div className="invoice-a5__parties">
              <div className="invoice-a5__party">
                <p className="invoice-a5__shop">{settings.shop_name}</p>
                {settings.shop_address && <p className="whitespace-pre-line">{settings.shop_address}</p>}
                {settings.shop_phone && <p>Phone: {settings.shop_phone}</p>}
                <p>GSTIN/UIN: {settings.shop_gstin || '-'}</p>
                <p>State Name : {shopState.name}, Code : {shopState.code}</p>
              </div>
              <div className="invoice-a5__party">
                <p className="invoice-a5__label">Buyer (Bill to)</p>
                {/* Billed to the bakery/shop; the person is who it is for. */}
                <p className="invoice-a5__buyer">{billCustomerDisplayName(bill, 'Walk-in Customer')}</p>
                {contactName && <p>Attn: {contactName}</p>}
                {bill.customer_address && <p className="whitespace-pre-line">{bill.customer_address}</p>}
                {bill.customer_phone && <p>Mob: {bill.customer_phone}</p>}
                {bill.customer_gstin && (
                  <>
                    <p>GSTIN/UIN: <strong>{bill.customer_gstin}</strong></p>
                    <p>State Name : {customerState.name}, Code : {customerState.code}</p>
                  </>
                )}
              </div>
            </div>
            <div className="invoice-a5__meta">
              <div>
                <p className="invoice-a5__label">Invoice No.</p>
                <p className="invoice-a5__value">{bill.bill_number}</p>
              </div>
              <div>
                <p className="invoice-a5__label">Dated</p>
                <p className="invoice-a5__value">{formatDateInIST(bill.created_at, undefined, BILL_LOCALE)}</p>
              </div>
              <div>
                <p className="invoice-a5__label">Mode of Payment</p>
                <p className="invoice-a5__value">{formatPaymentMethod(bill.payment_method)}</p>
                {paymentDetail && <p>{paymentDetail}</p>}
              </div>
              <div>
                <p className="invoice-a5__label">Time</p>
                <p className="invoice-a5__value">{formatTimeInIST(bill.created_at)}</p>
              </div>
              <div>
                <p className="invoice-a5__label">Place of Supply</p>
                <p className="invoice-a5__value">{placeOfSupply.name}</p>
              </div>
              <div>
                <p className="invoice-a5__label">Billed by</p>
                <p className="invoice-a5__value">{bill.cashier_name || '-'}</p>
              </div>
            </div>
          </div>

          <table className="invoice-a5__items">
            <colgroup>
              <col style={{ width: '5%' }} />
              <col />
              <col style={{ width: '11%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Sl No.</th>
                <th>Description of Goods</th>
                <th>HSN/SAC</th>
                <th className="num">Price (incl. GST)</th>
                <th className="num">Quantity</th>
                <th className="num">Rate</th>
                <th>per</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lineRows.map((row, index) => (
                <tr key={row.item.id}>
                  <td>{index + 1}</td>
                  <td className="invoice-a5__item">{row.item.item_name}</td>
                  <td>{row.item.hsn_code || '-'}</td>
                  <td className="num">{formatAmount(row.unitPrice)}</td>
                  <td className="num invoice-a5__strong">{formatQuantity(row.item.quantity)} {unitOf(row.item.metric)}</td>
                  <td className="num">{formatAmount(row.rate)}</td>
                  <td>{unitOf(row.item.metric)}</td>
                  <td className="num invoice-a5__strong">{formatAmount(row.taxable)}</td>
                </tr>
              ))}
              <tr className="invoice-a5__subtotal">
                <td /><td /><td /><td /><td /><td /><td />
                <td className="num">{formatAmount(subtotal)}</td>
              </tr>
              {hasIgst && (
                <tr>
                  <td /><td className="invoice-a5__charge">IGST</td><td /><td /><td /><td /><td />
                  <td className="num invoice-a5__strong">{formatAmount(gstSummary.igst)}</td>
                </tr>
              )}
              {(!hasIgst || gstSummary.cgst > 0) && (
                <>
                  <tr>
                    <td /><td className="invoice-a5__charge">CGST</td><td /><td /><td /><td /><td />
                    <td className="num invoice-a5__strong">{formatAmount(gstSummary.cgst)}</td>
                  </tr>
                  <tr>
                    <td /><td className="invoice-a5__charge">SGST</td><td /><td /><td /><td /><td />
                    <td className="num invoice-a5__strong">{formatAmount(gstSummary.sgst)}</td>
                  </tr>
                </>
              )}
              {bill.discount_amount > 0 && (
                <tr>
                  <td /><td className="invoice-a5__charge"><span className="invoice-a5__less">Less :</span>Discount</td><td /><td /><td /><td /><td />
                  <td className="num invoice-a5__strong">(-){formatAmount(bill.discount_amount)}</td>
                </tr>
              )}
              {roundOff !== 0 && (
                <tr>
                  <td />
                  <td className="invoice-a5__charge">
                    {roundOff < 0 && <span className="invoice-a5__less">Less :</span>}Round Off
                  </td>
                  <td /><td /><td /><td /><td />
                  <td className="num invoice-a5__strong">{roundOff < 0 ? `(-)${formatAmount(-roundOff)}` : formatAmount(roundOff)}</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td /><td className="num">Total</td><td /><td />
                <td className="num invoice-a5__strong">{totalQuantity}</td>
                <td /><td />
                <td className="num invoice-a5__grand">₹ {formatAmount(roundedTotal)}</td>
              </tr>
            </tfoot>
          </table>

          <div className="invoice-a5__words">
            <div className="invoice-a5__row">
              <span>Amount Chargeable (in words)</span>
              <span>E. &amp; O.E</span>
            </div>
            <p className="invoice-a5__strong">INR {toWords(roundedTotal)} Only</p>
          </div>

          <table className="invoice-a5__tax">
            <thead>
              <tr>
                <th rowSpan={2}>HSN/SAC</th>
                <th rowSpan={2} className="num">Taxable Value</th>
                {hasIgst && <th colSpan={2}>IGST</th>}
                {(!hasIgst || gstSummary.cgst > 0) && (
                  <>
                    <th colSpan={2}>CGST</th>
                    <th colSpan={2}>SGST/UTGST</th>
                  </>
                )}
                <th rowSpan={2} className="num">Total Tax Amount</th>
              </tr>
              <tr>
                {hasIgst && (<><th className="num">Rate</th><th className="num">Amount</th></>)}
                {(!hasIgst || gstSummary.cgst > 0) && (
                  <><th className="num">Rate</th><th className="num">Amount</th><th className="num">Rate</th><th className="num">Amount</th></>
                )}
              </tr>
            </thead>
            <tbody>
              {hsnRows.map((row) => (
                <tr key={`${row.hsn}-${row.cgstRate}-${row.sgstRate}-${row.igstRate}`}>
                  <td>{row.hsn}</td>
                  <td className="num">{formatAmount(row.taxable)}</td>
                  {hasIgst && (<><td className="num">{formatRate(row.igstRate)}</td><td className="num">{formatAmount(row.igstAmount)}</td></>)}
                  {(!hasIgst || gstSummary.cgst > 0) && (
                    <>
                      <td className="num">{formatRate(row.cgstRate)}</td>
                      <td className="num">{formatAmount(row.cgstAmount)}</td>
                      <td className="num">{formatRate(row.sgstRate)}</td>
                      <td className="num">{formatAmount(row.sgstAmount)}</td>
                    </>
                  )}
                  <td className="num">{formatAmount(row.cgstAmount + row.sgstAmount + row.igstAmount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="num">Total</td>
                <td className="num">{formatAmount(gstSummary.taxableValue)}</td>
                {hasIgst && (<><td /><td className="num">{formatAmount(gstSummary.igst)}</td></>)}
                {(!hasIgst || gstSummary.cgst > 0) && (
                  <><td /><td className="num">{formatAmount(gstSummary.cgst)}</td><td /><td className="num">{formatAmount(gstSummary.sgst)}</td></>
                )}
                <td className="num">{formatAmount(bill.tax_amount)}</td>
              </tr>
            </tfoot>
          </table>

          <p className="invoice-a5__taxwords">
            Tax Amount (in words) : <strong>INR {taxAmountInWords} Only</strong>
          </p>

          <div className="invoice-a5__foot">
            <div>
              <p className="invoice-a5__label invoice-a5__underline">Declaration</p>
              <p>We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.</p>
            </div>
            <div className="invoice-a5__sign">
              <p className="invoice-a5__strong">for {settings.shop_name}</p>
              <p>Authorised Signatory</p>
            </div>
          </div>
        </div>

        <p className="invoice-a5__generated">This is a Computer Generated Invoice</p>
      </div>
    );
  }

  return (
    <div className="receipt-paper mx-auto w-[80mm] bg-white p-3 font-mono text-[11px] text-black">
      <div className="text-center">
        <h1 className="text-[14px] font-bold uppercase">{settings.shop_name}</h1>
        <p className="mt-0.5 text-[10px]">{settings.shop_phone}</p>
        <p className="text-[10px]">GSTIN: {settings.shop_gstin}</p>
      </div>

      <div className="my-2 border-y border-dashed border-black py-1 text-[10px]">
        <div className="flex justify-between">
          <span>{bill.bill_number}</span>
          <span>{formatDateTimeCompactInIST(bill.created_at)}</span>
        </div>
        <div className="flex justify-between">
          <span>{billCustomerDisplayName(bill, 'Walk-in')}</span>
          <span className="uppercase">{bill.payment_method}</span>
        </div>
      </div>

      <table className="w-full text-[10px]">
        <thead>
          <tr className="border-b border-dashed border-black">
            <th className="py-1 text-left">Item</th>
            <th className="py-1 text-center">Qty</th>
            <th className="py-1 text-right">Amt</th>
          </tr>
        </thead>
        <tbody>
          {bill.items?.map((item) => (
            <tr key={item.id}>
              <td className="py-0.5">
                <div>{item.item_name}</div>
                <div className="text-[9px]">HSN {item.hsn_code || '-'}</div>
              </td>
              <td className="py-0.5 text-center">{item.quantity}</td>
              <td className="py-0.5 text-right">{formatMoney(item.total_amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-2 border-t border-dashed border-black pt-1 text-[10px]">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatMoney(subtotal)}</span>
        </div>
        <div className="flex justify-between">
          <span>GST</span>
          <span>{formatMoney(bill.tax_amount)}</span>
        </div>
        {bill.discount_amount > 0 && (
          <div className="flex justify-between">
            <span>Discount</span>
            <span>-{formatMoney(bill.discount_amount)}</span>
          </div>
        )}
        {roundOff !== 0 && (
          <div className="flex justify-between">
            <span>Round Off</span>
            <span>{formatMoney(roundOff)}</span>
          </div>
        )}
        <div className="mt-1 border-t border-black pt-1 flex justify-between text-[12px] font-bold">
          <span>Total</span>
          <span>{formatMoney(roundedTotal)}</span>
        </div>
      </div>
    </div>
  );
};
