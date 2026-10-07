import type { ParsedSource, QboInvoiceProjection, RawQboRecord } from './mapping.types';
import {
  compactQboNamespace,
  isJsonRecord,
  mappingIssue,
  parseQboReferenceId,
  qboDate,
  qboMoney,
  sumQboMoney,
  validateRawSource,
} from './mapping.helpers';

const INVOICE_QBO_FIELDS = [
  'DocNumber',
  'CustomerRef',
  'CurrencyRef',
  'LinkedTxn',
  'EmailStatus',
  'PrintStatus',
  'ApplyTaxAfterDiscount',
] as const;

export const mapQboInvoice = (
  raw: RawQboRecord,
): ParsedSource<QboInvoiceProjection> => {
  const source = validateRawSource(raw, 'Invoice');
  if (source.kind === 'deleted') return { kind: 'deleted', sourceId: source.sourceId };
  if (source.kind === 'skipped') return source;

  const customerSourceId = parseQboReferenceId(source.payload.CustomerRef);
  if (!customerSourceId) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'MISSING_CUSTOMER_REF') };
  }
  const totalAmount = qboMoney(source.payload.TotalAmt);
  if (totalAmount === null) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'INVALID_TOTAL_AMOUNT') };
  }
  const balance = qboMoney(source.payload.Balance);
  if (balance === null) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'INVALID_BALANCE') };
  }
  if (!isJsonRecord(source.payload.TxnTaxDetail)) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'INVALID_TAX') };
  }
  const tax = qboMoney(source.payload.TxnTaxDetail.TotalTax);
  if (tax === null) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'INVALID_TAX') };
  }

  const invoiceDate = qboDate(source.payload.TxnDate, true);
  if (invoiceDate === undefined) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'INVALID_TXN_DATE') };
  }
  const dueDate = qboDate(source.payload.DueDate, true);
  if (dueDate === undefined) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'INVALID_DUE_DATE') };
  }

  const lineValue = source.payload.Line;
  if (lineValue !== undefined && !Array.isArray(lineValue)) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'MALFORMED_INVOICE_LINES') };
  }
  const discountAmounts: unknown[] = [];
  for (const line of lineValue ?? []) {
    if (!isJsonRecord(line)) {
      return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'MALFORMED_INVOICE_LINE') };
    }
    if (line.DetailType === undefined) continue;
    if (typeof line.DetailType !== 'string') {
      return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'MALFORMED_INVOICE_LINE') };
    }
    if (line.DetailType === 'DiscountLineDetail') discountAmounts.push(line.Amount);
  }
  const discount = discountAmounts.length === 0 ? '0.00' : sumQboMoney(discountAmounts);
  if (discount === null) {
    return { kind: 'skipped', issue: mappingIssue('Invoice', source.sourceId, 'INVALID_DISCOUNT_AMOUNT') };
  }

  return {
    kind: 'mapped',
    value: {
      sourceId: source.sourceId,
      customerSourceId,
      totalAmount,
      balance,
      tax,
      discount,
      invoiceDate,
      dueDate,
      sourceSpecificData: compactQboNamespace(source.payload, INVOICE_QBO_FIELDS),
    },
  };
};
