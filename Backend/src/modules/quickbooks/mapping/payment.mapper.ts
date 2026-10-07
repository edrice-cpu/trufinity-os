import type { ParsedSource, QboPaymentProjection, RawQboRecord } from './mapping.types';
import {
  compactQboNamespace,
  mappingIssue,
  parseQboReferenceId,
  qboDate,
  qboMoney,
  validateRawSource,
} from './mapping.helpers';
import { mapQboPaymentApplications } from './payment-applications.mapper';

const PAYMENT_QBO_FIELDS = ['CustomerRef', 'CurrencyRef', 'PaymentMethodRef', 'ProcessPayment'] as const;

export const mapQboPayment = (
  raw: RawQboRecord,
): ParsedSource<QboPaymentProjection> => {
  const source = validateRawSource(raw, 'Payment');
  if (source.kind === 'deleted') return { kind: 'deleted', sourceId: source.sourceId };
  if (source.kind === 'skipped') return source;

  const customerSourceId = parseQboReferenceId(source.payload.CustomerRef);
  if (!customerSourceId) {
    return { kind: 'skipped', issue: mappingIssue('Payment', source.sourceId, 'MISSING_CUSTOMER_REF') };
  }
  const totalAmount = qboMoney(source.payload.TotalAmt);
  if (totalAmount === null) {
    return { kind: 'skipped', issue: mappingIssue('Payment', source.sourceId, 'INVALID_TOTAL_AMOUNT') };
  }
  const unappliedAmount = qboMoney(source.payload.UnappliedAmt);
  if (unappliedAmount === null) {
    return { kind: 'skipped', issue: mappingIssue('Payment', source.sourceId, 'INVALID_UNAPPLIED_AMOUNT') };
  }
  const paymentDate = qboDate(source.payload.TxnDate, false);
  if (paymentDate === undefined || paymentDate === null) {
    return { kind: 'skipped', issue: mappingIssue('Payment', source.sourceId, 'INVALID_TXN_DATE') };
  }

  const applications = mapQboPaymentApplications(source.sourceId, source.payload.Line);
  return {
    kind: 'mapped',
    value: {
      sourceId: source.sourceId,
      customerSourceId,
      totalAmount,
      unappliedAmount,
      paymentDate,
      sourceSpecificData: compactQboNamespace(source.payload, PAYMENT_QBO_FIELDS),
      applications: applications.applications,
      applicationIssues: applications.issues,
    },
  };
};
