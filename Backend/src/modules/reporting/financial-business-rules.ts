export type MoneyValue = string;

export type InvoiceClassification =
  | 'PAID'
  | 'PARTIALLY_PAID'
  | 'UNPAID'
  | 'ZERO_VALUE';

export interface ActiveInvoiceBalance {
  identityStatus: string;
  balance: MoneyValue;
}

export interface OutstandingArResult {
  amount: MoneyValue;
  includedInvoices: number;
  skippedInvoices: number;
}

export interface PaymentMeasures {
  paymentTotal: MoneyValue;
  unappliedAmount: MoneyValue;
  appliedAmount: MoneyValue;
  reconciliationDifference: MoneyValue;
  isReconciled: boolean;
}

const parseCents = (value: MoneyValue): bigint | null => {
  const normalized = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -cents : cents;
};

const formatCents = (cents: bigint): MoneyValue => {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return sign + (absolute / 100n).toString() + '.' + (absolute % 100n).toString().padStart(2, '0');
};

export const classifyInvoice = (
  totalAmount: MoneyValue,
  balance: MoneyValue,
): InvoiceClassification | null => {
  const total = parseCents(totalAmount);
  const outstanding = parseCents(balance);
  if (total === null || outstanding === null) return null;

  if (total === 0n && outstanding === 0n) return 'ZERO_VALUE';
  if (total > 0n && outstanding === 0n) return 'PAID';
  if (total > 0n && outstanding > 0n && outstanding < total) return 'PARTIALLY_PAID';
  if (total > 0n && outstanding === total) return 'UNPAID';
  return null;
};

export const calculateOutstandingAr = (
  invoices: ActiveInvoiceBalance[],
): OutstandingArResult => {
  let total = 0n;
  let includedInvoices = 0;
  let skippedInvoices = 0;

  for (const invoice of invoices) {
    const balance = parseCents(invoice.balance);
    if (invoice.identityStatus !== 'ACTIVE' || balance === null || balance < 0n) {
      skippedInvoices += 1;
      continue;
    }
    total += balance;
    includedInvoices += 1;
  }

  return {
    amount: formatCents(total),
    includedInvoices,
    skippedInvoices,
  };
};

export const calculatePaymentMeasures = (
  paymentTotal: MoneyValue,
  unappliedAmount: MoneyValue,
  appliedAmount: MoneyValue,
): PaymentMeasures | null => {
  const total = parseCents(paymentTotal);
  const unapplied = parseCents(unappliedAmount);
  const applied = parseCents(appliedAmount);
  if (total === null || unapplied === null || applied === null) return null;

  const reconciliationDifference = total - applied - unapplied;
  return {
    paymentTotal: formatCents(total),
    unappliedAmount: formatCents(unapplied),
    appliedAmount: formatCents(applied),
    reconciliationDifference: formatCents(reconciliationDifference),
    isReconciled: reconciliationDifference === 0n,
  };
};
