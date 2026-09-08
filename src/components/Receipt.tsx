import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Bill } from '../types';
import { useDataStore } from '../store/useDataStore';
import { formatDateInIST, formatDateTimeCompactInIST } from '../lib/utils';

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

const formatMoney = (value: number) => value.toFixed(2);

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

  const roundedValue = Math.round(value);
  if (roundedValue === 0) return 'Zero';

  const crore = Math.floor(roundedValue / 10000000);
  const lakh = Math.floor((roundedValue % 10000000) / 100000);
  const thousand = Math.floor((roundedValue % 100000) / 1000);
  const remainder = roundedValue % 1000;

  const parts = [
    crore ? `${convertBelowThousand(crore)} Crore` : '',
    lakh ? `${convertBelowThousand(lakh)} Lakh` : '',
    thousand ? `${convertBelowThousand(thousand)} Thousand` : '',
    remainder ? convertBelowThousand(remainder) : '',
  ].filter(Boolean);

  return parts.join(' ').trim();
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

  const subtotal = bill.total_amount - bill.tax_amount + bill.discount_amount;
  const roundedTotal = Math.round(bill.total_amount);
  const roundOff = roundedTotal - bill.total_amount;
  const shopState = {name: "Karnataka", code: "29" };
  const customerState = getStateFromGstin(bill.customer_gstin);

  const lineRows = (bill.items || []).map((item) => {
    const igst = item.igst_amount || 0;
    const taxable = item.total_amount - item.sgst_amount - item.cgst_amount - igst;
    const totalTax = item.sgst_amount + item.cgst_amount + igst;
    const qty = item.quantity || 0;
    const rate = qty > 0 ? taxable / qty : 0;
    const cgstRate = taxable > 0 ? (item.cgst_amount / taxable) * 100 : 0;
    const sgstRate = taxable > 0 ? (item.sgst_amount / taxable) * 100 : 0;
    const igstRate = taxable > 0 ? (igst / taxable) * 100 : 0;
    return {
      item,
      taxable,
      totalTax,
      rate,
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
    return (
      <div className="mx-auto w-full max-w-[210mm] border-2 border-black p-1.5 text-[9.5px] leading-tight text-black" style={{ backgroundColor: '#fff' }}>
        <div className="border border-black px-2 py-1 text-center text-[12px] font-bold tracking-[0.12em]">TAX INVOICE</div>

        <div className="mt-1 grid grid-cols-[1.2fr_0.8fr] gap-0">
          <div className="border border-black p-2">
            <p className="text-[14px] font-bold uppercase tracking-wide">{settings.shop_name}</p>
            <p className="mt-0.5 whitespace-pre-line font-semibold">{settings.shop_address}</p>
            <p className="mt-1">GSTIN/UIN: {settings.shop_gstin || '-'}</p>
            <p>State: {shopState.name} ({shopState.code})</p>
            <p>Phone: {settings.shop_phone || '-'}</p>
          </div>
          <table className="w-full border-collapse border border-black border-l-0 text-[9.5px]">
            <tbody>
              <tr>
                <td className="border border-black px-2 py-1 font-semibold">Invoice No.</td>
                <td className="border border-black px-2 py-1">{bill.bill_number}</td>
              </tr>
              <tr>
                <td className="border border-black px-2 py-1 font-semibold">Date</td>
                <td className="border border-black px-2 py-1">{formatDateInIST(bill.created_at)}</td>
              </tr>
              <tr>
                <td className="border border-black px-2 py-1 font-semibold">Payment</td>
                <td className="border border-black px-2 py-1">{formatPaymentMethod(bill.payment_method)}</td>
              </tr>
              <tr>
                <td className="border border-black px-2 py-1 font-semibold">Cashier</td>
                <td className="border border-black px-2 py-1">{bill.cashier_name || '-'}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-1 grid grid-cols-[1.2fr_0.8fr] gap-0">
          <div className="border border-black p-2">
            <p className="font-semibold uppercase tracking-wide">Bill To</p>
            <p className="mt-1 font-bold uppercase">{bill.customer_name || 'Walk-in Customer'}</p>
            <p className="mt-0.5 whitespace-pre-line">{bill.customer_address || '-'}</p>
            <p className="mt-0.5">GSTIN/UIN: {bill.customer_gstin || '-'}</p>
            <p>State: {customerState.name} ({customerState.code})</p>
            <p>Phone: {bill.customer_phone || '-'}</p>
          </div>
          <table className="w-full border-collapse border border-black border-l-0 text-[9.5px]">
            <tbody>
              <tr>
                <td className="border border-black px-2 py-1 font-semibold">Subtotal</td>
                <td className="border border-black px-2 py-1 text-right">{formatMoney(subtotal)}</td>
              </tr>
              <tr>
                <td className="border border-black px-2 py-1 font-semibold">Tax</td>
                <td className="border border-black px-2 py-1 text-right">{formatMoney(bill.tax_amount)}</td>
              </tr>
              {bill.discount_amount > 0 && (
                <tr>
                  <td className="border border-black px-2 py-1 font-semibold">Less</td>
                  <td className="border border-black px-2 py-1 text-right">-{formatMoney(bill.discount_amount)}</td>
                </tr>
              )}
              <tr>
                <td className="border border-black px-2 py-1 font-semibold">Round Off</td>
                <td className="border border-black px-2 py-1 text-right">{formatMoney(roundOff)}</td>
              </tr>
              <tr>
                <td className="border border-black px-2 py-1 text-[11px] font-bold">Grand Total</td>
                <td className="border border-black px-2 py-1 text-right text-[11px] font-bold">{formatMoney(roundedTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <table className="mt-1 w-full border-collapse border border-black text-[9.5px]">
          <thead>
            <tr style={{ backgroundColor: '#f4f4f4' }}>
              <th className="border border-black px-1 py-1 text-left font-semibold">Sl</th>
              <th className="border border-black px-1 py-1 text-left font-semibold">Description of Goods</th>
              <th className="border border-black px-1 py-1 text-left font-semibold">HSN/SAC</th>
              <th className="border border-black px-1 py-1 text-right font-semibold">Qty</th>
              <th className="border border-black px-1 py-1 text-right font-semibold">Rate</th>
              <th className="border border-black px-1 py-1 text-left font-semibold">Unit</th>
              <th className="border border-black px-1 py-1 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lineRows.map((row, index) => (
              <tr key={row.item.id}>
                <td className="border border-black px-1 py-0.5 align-top">{index + 1}</td>
                <td className="border border-black px-1 py-0.5 align-top font-semibold">{row.item.item_name}</td>
                <td className="border border-black px-1 py-0.5 align-top">{row.item.hsn_code || '-'}</td>
                <td className="border border-black px-1 py-0.5 text-right align-top">{row.item.quantity}</td>
                <td className="border border-black px-1 py-0.5 text-right align-top">{formatMoney(row.rate)}</td>
                <td className="border border-black px-1 py-0.5 align-top uppercase">{row.item.metric}</td>
                <td className="border border-black px-1 py-0.5 text-right align-top">{formatMoney(row.taxable)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-1 border border-black p-2 text-[9.5px]">
          <div className="flex items-end justify-between gap-2">
            <div>
              <p className="font-semibold">Amount Chargeable (in words)</p>
              <p className="mt-0.5 font-bold">INR {toWords(roundedTotal)} Only</p>
            </div>
            <p className="font-semibold">E. & O.E</p>
          </div>
        </div>

        <table className="mt-1 w-full border-collapse border border-black text-[9px]">
          <thead>
            <tr style={{ backgroundColor: '#f4f4f4' }}>
              <th className="border border-black px-1 py-0.5 text-left" rowSpan={2}>HSN/SAC</th>
              <th className="border border-black px-1 py-0.5 text-right" rowSpan={2}>Taxable Value</th>
              <th className="border border-black px-1 py-0.5 text-center" colSpan={2}>CGST</th>
              <th className="border border-black px-1 py-0.5 text-center" colSpan={2}>SGST/UTGST</th>
              <th className="border border-black px-1 py-0.5 text-right" rowSpan={2}>Total Tax</th>
            </tr>
            <tr style={{ backgroundColor: '#f4f4f4' }}>
              <th className="border border-black px-1 py-0.5 text-right">Rate</th>
              <th className="border border-black px-1 py-0.5 text-right">Amount</th>
              <th className="border border-black px-1 py-0.5 text-right">Rate</th>
              <th className="border border-black px-1 py-0.5 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {hsnRows.map((row) => (
              <tr key={`${row.hsn}-${row.cgstRate}-${row.sgstRate}-${row.igstRate}`}>
                <td className="border border-black px-1 py-0.5">{row.hsn}</td>
                <td className="border border-black px-1 py-0.5 text-right">{formatMoney(row.taxable)}</td>
                <td className="border border-black px-1 py-0.5 text-right">{row.cgstRate.toFixed(2)}%</td>
                <td className="border border-black px-1 py-0.5 text-right">{formatMoney(row.cgstAmount)}</td>
                <td className="border border-black px-1 py-0.5 text-right">{row.sgstRate.toFixed(2)}%</td>
                <td className="border border-black px-1 py-0.5 text-right">{formatMoney(row.sgstAmount)}</td>
                <td className="border border-black px-1 py-0.5 text-right">{formatMoney(row.cgstAmount + row.sgstAmount + row.igstAmount)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="border border-black px-1 py-0.5 text-right">Total</td>
              <td className="border border-black px-1 py-0.5 text-right">{formatMoney(gstSummary.taxableValue)}</td>
              <td className="border border-black px-1 py-0.5 text-right">-</td>
              <td className="border border-black px-1 py-0.5 text-right">{formatMoney(gstSummary.cgst)}</td>
              <td className="border border-black px-1 py-0.5 text-right">-</td>
              <td className="border border-black px-1 py-0.5 text-right">{formatMoney(gstSummary.sgst)}</td>
              <td className="border border-black px-1 py-0.5 text-right">{formatMoney(bill.tax_amount)}</td>
            </tr>
          </tbody>
        </table>

        <div className="mt-1 grid grid-cols-[1.35fr_0.65fr] gap-0 text-[9.5px]">
          <div className="border border-black p-2">
            <p className="font-semibold">Tax Amount (in words)</p>
            <p className="mt-0.5 font-bold">INR {taxAmountInWords} Only</p>
            <p className="mt-2 font-semibold">Declaration</p>
            <p className="mt-0.5">We declare that this invoice shows the actual price of the goods and all particulars are true and correct.</p>
          </div>
          <div className="border border-black border-l-0 p-2">
            <div className="mt-16 text-right font-semibold">Authorised Signatory</div>
          </div>
        </div>

        <div className="mt-1 border border-black py-1 text-center text-[9px]">This is a Computer Generated Invoice</div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-[80mm] bg-white p-3 font-mono text-[11px] text-black">
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
          <span>{bill.customer_name || 'Walk-in'}</span>
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
        <div className="mt-1 border-t border-black pt-1 flex justify-between text-[12px] font-bold">
          <span>Total</span>
          <span>{formatMoney(bill.total_amount)}</span>
        </div>
      </div>
    </div>
  );
};
