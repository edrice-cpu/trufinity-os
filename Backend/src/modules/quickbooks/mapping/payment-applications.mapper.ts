import type {
  MappingIssue,
  QboPaymentApplicationProjection,
  QboMappingSkipReason,
} from './mapping.types';
import { centsToQboMoney, isJsonRecord, mappingIssue, qboMoneyToCents } from './mapping.helpers';

export interface PaymentApplicationsResult {
  applications: QboPaymentApplicationProjection[];
  issues: MappingIssue[];
}

const applicationIssue = (
  paymentSourceId: string,
  reason: QboMappingSkipReason,
): MappingIssue => mappingIssue('PaymentApplication', paymentSourceId, reason);

export const mapQboPaymentApplications = (
  paymentSourceId: string,
  lineValue: unknown,
): PaymentApplicationsResult => {
  if (lineValue === undefined) return { applications: [], issues: [] };
  if (!Array.isArray(lineValue)) {
    return { applications: [], issues: [applicationIssue(paymentSourceId, 'MALFORMED_PAYMENT_LINES')] };
  }

  const totals = new Map<string, bigint>();
  const issues: MappingIssue[] = [];
  for (const line of lineValue) {
    if (!isJsonRecord(line)) {
      issues.push(applicationIssue(paymentSourceId, 'MALFORMED_PAYMENT_LINE'));
      continue;
    }
    if (line.LinkedTxn === undefined) continue;
    if (!Array.isArray(line.LinkedTxn)) {
      issues.push(applicationIssue(paymentSourceId, 'MALFORMED_LINKED_TXN'));
      continue;
    }

    const invoiceLinks: Record<string, unknown>[] = [];
    let malformedLink = false;
    for (const linkedTxn of line.LinkedTxn) {
      if (!isJsonRecord(linkedTxn)) {
        issues.push(applicationIssue(paymentSourceId, 'MALFORMED_LINKED_TXN'));
        malformedLink = true;
        continue;
      }
      if (typeof linkedTxn.TxnType !== 'string' || linkedTxn.TxnType.trim() === '') {
        issues.push(applicationIssue(paymentSourceId, 'MALFORMED_LINKED_TXN'));
        malformedLink = true;
        continue;
      }
      if (linkedTxn.TxnType === 'Invoice') invoiceLinks.push(linkedTxn);
    }
    if (malformedLink) continue;
    if (invoiceLinks.length === 0) continue;
    if (invoiceLinks.length > 1) {
      issues.push(applicationIssue(paymentSourceId, 'AMBIGUOUS_MULTIPLE_INVOICE_LINKS'));
      continue;
    }

    const invoiceSourceId = invoiceLinks[0].TxnId;
    if (typeof invoiceSourceId !== 'string' || invoiceSourceId.trim() === '') {
      issues.push(applicationIssue(paymentSourceId, 'MISSING_LINKED_TXN_ID'));
      continue;
    }
    const cents = qboMoneyToCents(line.Amount);
    if (cents === null) {
      issues.push(applicationIssue(paymentSourceId, 'INVALID_APPLICATION_AMOUNT'));
      continue;
    }
    totals.set(invoiceSourceId, (totals.get(invoiceSourceId) ?? 0n) + cents);
  }

  const applications: QboPaymentApplicationProjection[] = [];
  for (const [invoiceSourceId, cents] of totals) {
    const appliedAmount = centsToQboMoney(cents);
    if (appliedAmount === null) {
      issues.push(applicationIssue(paymentSourceId, 'INVALID_APPLICATION_AMOUNT'));
      continue;
    }
    applications.push({ invoiceSourceId, appliedAmount });
  }
  applications.sort((left, right) => left.invoiceSourceId.localeCompare(right.invoiceSourceId));
  return { applications, issues };
};
