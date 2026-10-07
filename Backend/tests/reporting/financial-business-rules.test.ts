import { describe, expect, it } from '@jest/globals';
import {
  calculateOutstandingAr,
  calculatePaymentMeasures,
  classifyInvoice,
} from '../../src/modules/reporting/financial-business-rules';

describe('Step 4 financial business rules', () => {
  it.each([
    ['PAID', '100.00', '0.00'],
    ['PARTIALLY_PAID', '100.00', '25.00'],
    ['UNPAID', '100.00', '100.00'],
    ['ZERO_VALUE', '0.00', '0.00'],
  ])('classifies invoices using total and balance: %s', (expected, total, balance) => {
    expect(classifyInvoice(total, balance)).toBe(expected);
  });

  it('does not invent a classification for unsupported negative or overpaid values', () => {
    expect(classifyInvoice('-10.00', '0.00')).toBeNull();
    expect(classifyInvoice('100.00', '125.00')).toBeNull();
  });

  it('calculates AR only from valid ACTIVE invoice identities', () => {
    expect(calculateOutstandingAr([
      { identityStatus: 'ACTIVE', balance: '100.00' },
      { identityStatus: 'ACTIVE', balance: '25.50' },
      { identityStatus: 'DELETED', balance: '75.00' },
      { identityStatus: 'ACTIVE', balance: 'invalid' },
    ])).toEqual({ amount: '125.50', includedInvoices: 2, skippedInvoices: 2 });
  });

  it('returns zero AR for an empty invoice set', () => {
    expect(calculateOutstandingAr([])).toEqual({ amount: '0.00', includedInvoices: 0, skippedInvoices: 0 });
  });

  it('keeps payment totals, unapplied amounts, and applications as separate measures', () => {
    expect(calculatePaymentMeasures('100.00', '10.00', '90.00')).toEqual({
      paymentTotal: '100.00',
      unappliedAmount: '10.00',
      appliedAmount: '90.00',
      reconciliationDifference: '0.00',
      isReconciled: true,
    });
  });

  it('flags unreconciled applications without changing any measure', () => {
    expect(calculatePaymentMeasures('100.00', '0.00', '125.00')).toEqual({
      paymentTotal: '100.00',
      unappliedAmount: '0.00',
      appliedAmount: '125.00',
      reconciliationDifference: '-25.00',
      isReconciled: false,
    });
  });
});
