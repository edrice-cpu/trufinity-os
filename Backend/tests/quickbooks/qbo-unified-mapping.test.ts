import { describe, expect, it } from '@jest/globals';
import { mapQboCustomer } from '../../src/modules/quickbooks/mapping/customer.mapper';
import { mapQboInvoice } from '../../src/modules/quickbooks/mapping/invoice.mapper';
import { mapQboPayment } from '../../src/modules/quickbooks/mapping/payment.mapper';
import { mapQboPaymentApplications } from '../../src/modules/quickbooks/mapping/payment-applications.mapper';
import { QboUnifiedMappingService } from '../../src/modules/quickbooks/mapping/qbo-unified-mapping.service';
import {
  QBO_MAPPING_PAGE_SIZE,
  type MappingIssue,
  type QboCustomerProjection,
  type QboInvoiceProjection,
  type QboMappingBatchResult,
  type QboPaymentProjection,
  type QboRawEntity,
  type QboUnifiedMappingStore,
  type RawQboRecord,
} from '../../src/modules/quickbooks/mapping/mapping.types';

const raw = (
  sourceId: string,
  payload: Record<string, unknown>,
  isDeleted = false,
): RawQboRecord => ({ source_id: sourceId, payload: { Id: sourceId, ...payload }, is_deleted: isDeleted });

const customerRecord = (sourceId = 'c-1'): RawQboRecord =>
  raw(sourceId, { DisplayName: 'Test Customer', Active: false, CompanyName: 'Test Co', UnusedRawField: 'not copied' });

const invoiceRecord = (
  sourceId = 'i-1',
  customerSourceId = 'c-1',
  extra: Record<string, unknown> = {},
): RawQboRecord => raw(sourceId, {
  CustomerRef: { value: customerSourceId },
  TotalAmt: 180.52,
  Balance: 25.1,
  TxnTaxDetail: { TotalTax: 12.03 },
  TxnDate: '2026-09-01',
  DueDate: '2026-09-30',
  Line: [
    { DetailType: 'SalesItemLineDetail', Amount: 180.52 },
    { DetailType: 'DiscountLineDetail', Amount: 4.1 },
    { DetailType: 'DiscountLineDetail', Amount: 2.2 },
  ],
  DocNumber: 'INV-1',
  ...extra,
});

const paymentRecord = (
  sourceId = 'p-1',
  customerSourceId = 'c-1',
  invoiceSourceId = 'i-1',
): RawQboRecord => raw(sourceId, {
  CustomerRef: { value: customerSourceId },
  TotalAmt: 40.25,
  UnappliedAmt: 5.25,
  TxnDate: '2026-09-02',
  PaymentMethodRef: { value: 'method-1', name: 'Card' },
  PaymentType: 'CreditCard',
  Line: [
    { Amount: 10.25, LinkedTxn: [{ TxnId: invoiceSourceId, TxnType: 'Invoice' }] },
    { Amount: 4, LinkedTxn: [{ TxnId: invoiceSourceId, TxnType: 'Invoice' }] },
    { Amount: 2, LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }] },
  ],
});

const setPaymentLines = (record: RawQboRecord, lines: unknown[]): void => {
  const payload = record.payload as Record<string, unknown>;
  record.payload = { ...payload, Line: lines };
};

const invoicePaymentLine = (invoiceSourceId: string, amount: unknown): Record<string, unknown> => ({
  Amount: amount,
  LinkedTxn: [{ TxnId: invoiceSourceId, TxnType: 'Invoice' }],
});

interface FakeIdentity {
  targetId: string | null;
  status: string;
}

interface FakeRun {
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  recordsProcessed: number;
  errorMessage: string | null;
}

class InMemoryMappingStore implements QboUnifiedMappingStore {
  public readonly raw: Record<QboRawEntity, RawQboRecord[]> = {
    Customers: [],
    Invoices: [],
    Payments: [],
  };
  public readonly identities = new Map<string, FakeIdentity>();
  public readonly customers = new Map<string, Record<string, unknown>>();
  public readonly invoices = new Map<string, Record<string, unknown>>();
  public readonly payments = new Map<string, Record<string, unknown>>();
  public readonly applications = new Map<string, { amount: string; appliedOn: null }>();
  public readonly errors: { sourceId: string | null; error: string; payload: null }[] = [];
  public readonly calls: string[] = [];
  public readonly runs = new Map<string, FakeRun>();
  public lockContended = false;
  private locked = false;
  private nextId = 1;
  private nextRun = 1;

  public async acquireLocks(): Promise<(() => Promise<void>) | null> {
    this.calls.push('acquire');
    if (this.lockContended || this.locked) return null;
    this.locked = true;
    return async () => { this.locked = false; this.calls.push('release'); };
  }

  public async recoverStaleRuns(): Promise<void> { this.calls.push('recover'); }

  public async createRun(): Promise<string> {
    this.calls.push('create');
    const id = 'run-' + this.nextRun++;
    this.runs.set(id, { status: 'RUNNING', recordsProcessed: 0, errorMessage: null });
    return id;
  }

  public async loadLatestBatch(entity: QboRawEntity, after: string | null, limit: number): Promise<RawQboRecord[]> {
    const sorted = [...this.raw[entity]].sort((left, right) => left.source_id.localeCompare(right.source_id));
    return sorted.filter((record) => after === null || record.source_id > after).slice(0, limit);
  }

  public async persistCustomers(runId: string, records: QboCustomerProjection[], deletedIds: string[], issues: MappingIssue[]): Promise<QboMappingBatchResult> {
    const allIssues = [...issues];
    this.markDeleted('Customer', deletedIds);
    for (const record of records) {
      const identity = this.identity('Customer', record.sourceId);
      if (identity && (!identity.targetId || !this.customers.has(identity.targetId))) throw new Error('inconsistent Customer target');
    }
    for (const record of records) {
      const identity = this.identity('Customer', record.sourceId);
      const targetId = identity?.targetId ?? this.newId();
      this.customers.set(targetId, { id: targetId, name: record.name, sourceSpecificData: record.sourceSpecificData });
      if (!identity) this.identities.set(this.key('Customer', record.sourceId), { targetId, status: 'ACTIVE' });
      else identity.status = 'ACTIVE';
    }
    this.addIssues(runId, allIssues);
    return this.result(records.length, deletedIds.filter((id) => this.identities.has(this.key('Customer', id))).length, allIssues, 0);
  }

  public async persistInvoices(runId: string, records: QboInvoiceProjection[], deletedIds: string[], issues: MappingIssue[]): Promise<QboMappingBatchResult> {
    const allIssues = [...issues];
    this.markDeleted('Invoice', deletedIds);
    const accepted: QboInvoiceProjection[] = [];
    for (const record of records) {
      const customer = this.identity('Customer', record.customerSourceId);
      if (!customer || customer.status === 'DELETED') {
        allIssues.push({ entity: 'Invoice', sourceId: record.sourceId, reason: 'CUSTOMER_IDENTITY_NOT_FOUND' });
        continue;
      }
      if (!customer.targetId || !this.customers.has(customer.targetId)) throw new Error('inconsistent Customer target');
      const identity = this.identity('Invoice', record.sourceId);
      if (identity && (!identity.targetId || !this.invoices.has(identity.targetId))) throw new Error('inconsistent Invoice target');
      accepted.push(record);
    }
    for (const record of accepted) {
      const identity = this.identity('Invoice', record.sourceId);
      const targetId = identity?.targetId ?? this.newId();
      const customerId = this.identity('Customer', record.customerSourceId)!.targetId!;
      this.invoices.set(targetId, {
        id: targetId,
        unified_customer_id: customerId,
        status: null,
        total_amount: record.totalAmount,
        balance: record.balance,
        tax: record.tax,
        discount: record.discount,
        invoice_date: record.invoiceDate,
        due_date: record.dueDate,
        source_specific_data: record.sourceSpecificData,
      });
      if (!identity) this.identities.set(this.key('Invoice', record.sourceId), { targetId, status: 'ACTIVE' });
      else identity.status = 'ACTIVE';
    }
    this.addIssues(runId, allIssues);
    return this.result(accepted.length, deletedIds.filter((id) => this.identities.has(this.key('Invoice', id))).length, allIssues, 0);
  }

  public async persistPayments(runId: string, records: QboPaymentProjection[], deletedIds: string[], issues: MappingIssue[]): Promise<QboMappingBatchResult> {
    const allIssues = [...issues];
    this.markDeleted('Payment', deletedIds);
    const accepted: QboPaymentProjection[] = [];
    for (const record of records) {
      const customer = this.identity('Customer', record.customerSourceId);
      if (!customer || customer.status === 'DELETED') {
        allIssues.push({ entity: 'Payment', sourceId: record.sourceId, reason: 'CUSTOMER_IDENTITY_NOT_FOUND' });
        continue;
      }
      if (!customer.targetId || !this.customers.has(customer.targetId)) throw new Error('inconsistent Customer target');
      const identity = this.identity('Payment', record.sourceId);
      if (identity && (!identity.targetId || !this.payments.has(identity.targetId))) throw new Error('inconsistent Payment target');
      accepted.push(record);
    }
    for (const record of accepted) {
      const identity = this.identity('Payment', record.sourceId);
      const targetId = identity?.targetId ?? this.newId();
      const customerId = this.identity('Customer', record.customerSourceId)!.targetId!;
      this.payments.set(targetId, {
        id: targetId,
        unified_customer_id: customerId,
        status: null,
        type: null,
        total_amount: record.totalAmount,
        unapplied_amount: record.unappliedAmount,
        payment_date: record.paymentDate,
        source_specific_data: record.sourceSpecificData,
      });
      if (!identity) this.identities.set(this.key('Payment', record.sourceId), { targetId, status: 'ACTIVE' });
      else identity.status = 'ACTIVE';
    }
    this.addIssues(runId, allIssues);
    return this.result(accepted.length, deletedIds.filter((id) => this.identities.has(this.key('Payment', id))).length, allIssues, 0);
  }

  public async persistPaymentApplications(runId: string, records: QboPaymentProjection[]): Promise<QboMappingBatchResult> {
    const issues = records.flatMap((record) => record.applicationIssues);
    let mapped = 0;
    for (const record of records) {
      const payment = this.identity('Payment', record.sourceId);
      if (!payment || payment.status !== 'ACTIVE') {
        if (record.applications.length) issues.push({ entity: 'PaymentApplication', sourceId: record.sourceId, reason: 'PAYMENT_IDENTITY_NOT_FOUND' });
        continue;
      }
      if (!payment.targetId || !this.payments.has(payment.targetId)) throw new Error('inconsistent Payment target');
      const customer = this.identity('Customer', record.customerSourceId);
      if (!customer || customer.status !== 'ACTIVE') {
        if (record.applications.length) issues.push({ entity: 'PaymentApplication', sourceId: record.sourceId, reason: 'CUSTOMER_IDENTITY_NOT_FOUND' });
        continue;
      }
      if (record.applicationIssues.length > 0) continue;

      const expected = new Map<string, { amount: string; appliedOn: null }>();
      let complete = true;
      for (const application of record.applications) {
        const invoice = this.identity('Invoice', application.invoiceSourceId);
        if (!invoice || invoice.status !== 'ACTIVE') {
          issues.push({ entity: 'PaymentApplication', sourceId: record.sourceId, reason: 'INVOICE_IDENTITY_NOT_FOUND' });
          complete = false;
          continue;
        }
        if (!invoice.targetId || !this.invoices.has(invoice.targetId)) throw new Error('inconsistent Invoice target');
        expected.set(invoice.targetId, { amount: application.appliedAmount, appliedOn: null });
      }
      if (!complete) continue;

      for (const [invoiceId, value] of expected) {
        this.applications.set(payment.targetId + ':' + invoiceId, value);
      }
      const paymentPrefix = payment.targetId + ':';
      for (const key of this.applications.keys()) {
        if (key.startsWith(paymentPrefix) && !expected.has(key.slice(paymentPrefix.length))) {
          this.applications.delete(key);
        }
      }
      mapped += expected.size;
    }
    this.addIssues(runId, issues);
    return this.result(0, 0, issues, mapped);
  }

  public async completeRun(runId: string, recordsProcessed: number): Promise<void> {
    const run = this.runs.get(runId)!;
    run.status = 'COMPLETED';
    run.recordsProcessed = recordsProcessed;
    this.calls.push('complete');
  }

  public async failRun(runId: string, message: string, recordsProcessed: number): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.status = 'FAILED';
      run.errorMessage = message;
      run.recordsProcessed = recordsProcessed;
    }
  }

  private key(entity: string, sourceId: string): string { return entity + ':' + sourceId; }
  private identity(entity: string, sourceId: string): FakeIdentity | undefined { return this.identities.get(this.key(entity, sourceId)); }
  private newId(): string { return 'unified-' + this.nextId++; }

  private markDeleted(entity: string, sourceIds: string[]): void {
    for (const sourceId of sourceIds) {
      const identity = this.identity(entity, sourceId);
      if (identity) identity.status = 'DELETED';
    }
  }

  private addIssues(runId: string, issues: MappingIssue[]): void {
    if (!this.runs.has(runId)) throw new Error('missing run');
    this.errors.push(...issues.map((issue) => ({
      sourceId: issue.sourceId,
      error: 'QBO_MAPPING:' + issue.entity + ':' + issue.reason,
      payload: null,
    })));
  }

  private result(mapped: number, deleted: number, issues: MappingIssue[], applicationMapped: number): QboMappingBatchResult {
    return {
      mapped,
      deleted,
      skipped: issues.filter((issue) => issue.entity !== 'PaymentApplication').length,
      applicationMapped,
      applicationSkipped: issues.filter((issue) => issue.entity === 'PaymentApplication').length,
      issues,
    };
  }
}

describe('QBO unified mapping', () => {
  it('maps inactive Customers by DisplayName and stores a compact namespace', () => {
    const result = mapQboCustomer(customerRecord());
    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.value.name).toBe('Test Customer');
    expect(result.value.sourceSpecificData.quickbooks).toMatchObject({ Active: false, CompanyName: 'Test Co' });
    expect(result.value.sourceSpecificData.quickbooks).not.toHaveProperty('UnusedRawField');
  });

  it('validates source identity and treats explicit deleted raw versions separately', () => {
    expect(mapQboCustomer(raw('c-1', { Id: 'different', DisplayName: 'Mismatch' })).kind).toBe('skipped');
    const deleted = mapQboCustomer(raw('c-1', {}, true));
    expect(deleted).toEqual({ kind: 'deleted', sourceId: 'c-1' });
    expect(mapQboCustomer(customerRecord()).kind).toBe('mapped');
  });

  it('maps Invoice financial fields, exact CustomerRef, nullable dates, and summed discount lines', () => {
    const result = mapQboInvoice(invoiceRecord());
    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.value).toMatchObject({
      sourceId: 'i-1',
      customerSourceId: 'c-1',
      totalAmount: '180.52',
      balance: '25.10',
      tax: '12.03',
      discount: '6.30',
      invoiceDate: '2026-09-01',
      dueDate: '2026-09-30',
    });
  });

  it('uses zero only when no DiscountLineDetail exists and rejects malformed required Invoice amounts', () => {
    const noDiscount = mapQboInvoice(invoiceRecord('i-2', 'c-1', {
      Line: [{ DetailType: 'SalesItemLineDetail', Amount: 10 }],
      TxnDate: undefined,
      DueDate: undefined,
    }));
    expect(noDiscount.kind).toBe('mapped');
    if (noDiscount.kind === 'mapped') {
      expect(noDiscount.value.discount).toBe('0.00');
      expect(noDiscount.value.invoiceDate).toBeNull();
      expect(noDiscount.value.dueDate).toBeNull();
    }
    expect(mapQboInvoice(invoiceRecord('i-3', 'c-1', { Balance: undefined }))).toMatchObject({
      kind: 'skipped',
      issue: { reason: 'INVALID_BALANCE' },
    });
    expect(mapQboInvoice(invoiceRecord('i-4', 'c-1', { TotalAmt: '100.00' }))).toMatchObject({
      kind: 'skipped',
      issue: { reason: 'INVALID_TOTAL_AMOUNT' },
    });
    expect(mapQboInvoice(invoiceRecord('i-5', 'c-1', { TxnTaxDetail: {} }))).toMatchObject({
      kind: 'skipped',
      issue: { reason: 'INVALID_TAX' },
    });
  });

  it('maps Payments with null status/type semantics and keeps PaymentMethodRef in QBO data', () => {
    const result = mapQboPayment(paymentRecord());
    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.value).toMatchObject({
      customerSourceId: 'c-1',
      totalAmount: '40.25',
      unappliedAmount: '5.25',
      paymentDate: '2026-09-02',
    });
    expect(result.value.sourceSpecificData.quickbooks).toMatchObject({
      PaymentMethodRef: { value: 'method-1', name: 'Card' },
    });
    expect(result.value.sourceSpecificData.quickbooks).not.toHaveProperty('PaymentType');
    expect(result.value.applications).toEqual([{ invoiceSourceId: 'i-1', appliedAmount: '14.25' }]);
    expect(mapQboPayment(raw('p-2', {
      CustomerRef: { value: 'c-1' }, TotalAmt: 10, UnappliedAmt: undefined, TxnDate: '2026-09-02',
    }))).toMatchObject({ kind: 'skipped', issue: { reason: 'INVALID_UNAPPLIED_AMOUNT' } });
  });

  it('maps only Invoice links, aggregates repeated pairs, and skips ambiguous multi-Invoice lines', () => {
    const result = mapQboPaymentApplications('p-1', [
      { Amount: 5.1, LinkedTxn: [{ TxnId: 'i-1', TxnType: 'Invoice' }] },
      { Amount: 2.2, LinkedTxn: [{ TxnId: 'i-1', TxnType: 'Invoice' }] },
      { Amount: 9, LinkedTxn: [{ TxnId: 'b-1', TxnType: 'Bill' }] },
      { Amount: 7, LinkedTxn: [{ TxnId: 'i-1', TxnType: 'Invoice' }, { TxnId: 'i-2', TxnType: 'Invoice' }] },
    ]);
    expect(result.applications).toEqual([{ invoiceSourceId: 'i-1', appliedAmount: '7.30' }]);
    expect(result.issues).toEqual([{ entity: 'PaymentApplication', sourceId: 'p-1', reason: 'AMBIGUOUS_MULTIPLE_INVOICE_LINKS' }]);
  });

  it('runs Customer -> Invoice -> Payment -> Payment Application and remains idempotent on rerun', async () => {
    const store = new InMemoryMappingStore();
    store.raw.Customers = [customerRecord()];
    store.raw.Invoices = [invoiceRecord()];
    store.raw.Payments = [paymentRecord()];
    const service = new QboUnifiedMappingService(store);

    const first = await service.run();
    const customerId = store.identities.get('Customer:c-1')?.targetId;
    const invoiceId = store.identities.get('Invoice:i-1')?.targetId;
    const paymentId = store.identities.get('Payment:p-1')?.targetId;
    const pair = paymentId + ':' + invoiceId;
    expect(first.recordsProcessed).toBe(3);
    expect(first.customers.mapped).toBe(1);
    expect(first.invoices.mapped).toBe(1);
    expect(first.payments.mapped).toBe(1);
    expect(first.paymentApplications).toEqual({ mapped: 1, skipped: 0 });
    expect(store.customers.get(customerId!)?.name).toBe('Test Customer');
    expect(store.invoices.get(invoiceId!)?.status).toBeNull();
    expect(store.payments.get(paymentId!)?.status).toBeNull();
    expect(store.payments.get(paymentId!)?.type).toBeNull();
    expect(store.applications.get(pair)).toEqual({ amount: '14.25', appliedOn: null });

    await service.run();
    expect(store.customers.size).toBe(1);
    expect(store.invoices.size).toBe(1);
    expect(store.payments.size).toBe(1);
    expect(store.identities.get('Customer:c-1')?.targetId).toBe(customerId);
    expect(store.identities.get('Invoice:i-1')?.targetId).toBe(invoiceId);
    expect(store.identities.get('Payment:p-1')?.targetId).toBe(paymentId);
    expect(store.applications.get(pair)).toEqual({ amount: '14.25', appliedOn: null });
    expect(store.runs.get(first.syncRunId)?.status).toBe('COMPLETED');
    expect(store.calls.slice(0, 4)).toEqual(['acquire', 'recover', 'create', 'complete']);
    expect(store.calls.filter((call) => call === 'release')).toHaveLength(2);
  });

  it('recomputes a still-present application amount instead of incrementing it', async () => {
    const store = new InMemoryMappingStore();
    store.raw.Customers = [customerRecord()];
    store.raw.Invoices = [invoiceRecord()];
    const payment = paymentRecord();
    store.raw.Payments = [payment];
    const service = new QboUnifiedMappingService(store);

    await service.run();
    const paymentId = store.identities.get('Payment:p-1')?.targetId!;
    const invoiceId = store.identities.get('Invoice:i-1')?.targetId!;
    const pair = paymentId + ':' + invoiceId;
    expect(store.applications.get(pair)?.amount).toBe('14.25');

    setPaymentLines(payment, [invoicePaymentLine('i-1', 8.5)]);
    await service.run();
    expect(store.applications.get(pair)).toEqual({ amount: '8.50', appliedOn: null });

    await service.run();
    expect(store.applications.size).toBe(1);
    expect(store.applications.get(pair)).toEqual({ amount: '8.50', appliedOn: null });
  });

  it('removes disappeared invoice links while preserving rows for other payments and clears valid zero-link payments', async () => {
    const store = new InMemoryMappingStore();
    store.raw.Customers = [customerRecord()];
    store.raw.Invoices = [invoiceRecord('i-1'), invoiceRecord('i-2')];
    const firstPayment = paymentRecord('p-1', 'c-1', 'i-1');
    const otherPayment = paymentRecord('p-2', 'c-1', 'i-2');
    store.raw.Payments = [firstPayment, otherPayment];
    const service = new QboUnifiedMappingService(store);

    await service.run();
    const firstPaymentId = store.identities.get('Payment:p-1')?.targetId!;
    const otherPaymentId = store.identities.get('Payment:p-2')?.targetId!;
    const invoiceOneId = store.identities.get('Invoice:i-1')?.targetId!;
    const invoiceTwoId = store.identities.get('Invoice:i-2')?.targetId!;
    expect(store.applications.has(firstPaymentId + ':' + invoiceOneId)).toBe(true);
    expect(store.applications.has(otherPaymentId + ':' + invoiceTwoId)).toBe(true);

    setPaymentLines(firstPayment, [invoicePaymentLine('i-2', 6)]);
    await service.run();
    expect(store.applications.has(firstPaymentId + ':' + invoiceOneId)).toBe(false);
    expect(store.applications.get(firstPaymentId + ':' + invoiceTwoId)).toEqual({ amount: '6.00', appliedOn: null });
    expect(store.applications.get(otherPaymentId + ':' + invoiceTwoId)).toEqual({ amount: '14.25', appliedOn: null });

    setPaymentLines(firstPayment, []);
    await service.run();
    expect([...store.applications.keys()].some((key) => key.startsWith(firstPaymentId + ':'))).toBe(false);
    expect(store.applications.get(otherPaymentId + ':' + invoiceTwoId)).toEqual({ amount: '14.25', appliedOn: null });
  });

  it('preserves prior applications when any expected Invoice identity is unresolved', async () => {
    const store = new InMemoryMappingStore();
    store.raw.Customers = [customerRecord()];
    store.raw.Invoices = [invoiceRecord('i-1'), invoiceRecord('i-2')];
    const payment = paymentRecord('p-1', 'c-1', 'i-1');
    store.raw.Payments = [payment];
    const service = new QboUnifiedMappingService(store);
    await service.run();

    const paymentId = store.identities.get('Payment:p-1')?.targetId!;
    const invoiceOneId = store.identities.get('Invoice:i-1')?.targetId!;
    setPaymentLines(payment, [invoicePaymentLine('i-1', 5), invoicePaymentLine('i-2', 12)]);
    store.raw.Invoices = [invoiceRecord('i-1')];
    store.identities.get('Invoice:i-2')!.status = 'DELETED';

    const result = await service.run();
    expect(result.skippedByReason.INVOICE_IDENTITY_NOT_FOUND).toBe(1);
    expect(store.applications.get(paymentId + ':' + invoiceOneId)).toEqual({ amount: '14.25', appliedOn: null });
    expect(store.applications.has(paymentId + ':' + store.identities.get('Invoice:i-2')?.targetId)).toBe(false);
  });

  it.each([
    {
      name: 'ambiguous multi-Invoice line',
      lines: [{ Amount: 20, LinkedTxn: [
        { TxnId: 'i-1', TxnType: 'Invoice' },
        { TxnId: 'i-2', TxnType: 'Invoice' },
      ] }],
      reason: 'AMBIGUOUS_MULTIPLE_INVOICE_LINKS',
    },
    {
      name: 'malformed application amount',
      lines: [invoicePaymentLine('i-1', 'invalid')],
      reason: 'INVALID_APPLICATION_AMOUNT',
    },
    {
      name: 'malformed linked transaction without a type',
      lines: [{ Amount: 20, LinkedTxn: [{ TxnId: 'i-1' }] }],
      reason: 'MALFORMED_LINKED_TXN',
    },
  ])('preserves prior applications for an incomplete $name', async ({ lines, reason }) => {
    const store = new InMemoryMappingStore();
    store.raw.Customers = [customerRecord()];
    store.raw.Invoices = [invoiceRecord('i-1'), invoiceRecord('i-2')];
    const payment = paymentRecord();
    store.raw.Payments = [payment];
    const service = new QboUnifiedMappingService(store);
    await service.run();
    const paymentId = store.identities.get('Payment:p-1')?.targetId!;
    const invoiceId = store.identities.get('Invoice:i-1')?.targetId!;
    const pair = paymentId + ':' + invoiceId;
    expect(store.applications.get(pair)?.amount).toBe('14.25');

    setPaymentLines(payment, lines);
    const result = await service.run();
    expect(result.skippedByReason).toMatchObject({ [reason]: 1 });
    expect(store.applications.get(pair)).toEqual({ amount: '14.25', appliedOn: null });
  });

  it('skips missing Customer/Invoice identities, preserves deleted history, and writes only reason-coded issues', async () => {
    const store = new InMemoryMappingStore();
    store.raw.Invoices = [invoiceRecord('i-missing-customer', 'not-mapped')];
    store.raw.Customers = [customerRecord()];
    store.raw.Payments = [paymentRecord('p-missing-invoice', 'c-1', 'not-mapped')];
    const service = new QboUnifiedMappingService(store);
    const first = await service.run();
    expect(first.invoices.skipped).toBe(1);
    expect(first.paymentApplications.skipped).toBe(1);
    expect(first.skippedByReason.CUSTOMER_IDENTITY_NOT_FOUND).toBe(1);
    expect(first.skippedByReason.INVOICE_IDENTITY_NOT_FOUND).toBe(1);
    expect(store.errors.every((error) => error.payload === null && error.error.startsWith('QBO_MAPPING:'))).toBe(true);

    const targetId = store.identities.get('Customer:c-1')?.targetId;
    store.raw.Customers = [raw('c-1', { Active: false }, true)];
    await service.run();
    expect(store.identities.get('Customer:c-1')?.status).toBe('DELETED');
    expect(store.customers.has(targetId!)).toBe(true);
  });

  it('fails safely on an identity pointer whose unified target is missing', async () => {
    const store = new InMemoryMappingStore();
    store.raw.Customers = [customerRecord()];
    store.identities.set('Customer:c-1', { targetId: 'missing-target', status: 'ACTIVE' });
    const service = new QboUnifiedMappingService(store);
    await expect(service.run()).rejects.toThrow('QuickBooks unified mapping failed');
    expect([...store.runs.values()][0].status).toBe('FAILED');
    expect(store.customers.size).toBe(0);
  });

  it('does not create a run when a source advisory lock is contended', async () => {
    const store = new InMemoryMappingStore();
    store.lockContended = true;
    await expect(new QboUnifiedMappingService(store).run()).rejects.toThrow('QuickBooks unified mapping failed during acquire_locks.');
    expect(store.runs.size).toBe(0);
    expect(store.calls).toEqual(['acquire']);
  });

  it('uses bounded pages and clears failed status only through the explicit completion path', async () => {
    const store = new InMemoryMappingStore();
    store.raw.Customers = Array.from({ length: QBO_MAPPING_PAGE_SIZE + 1 }, (_, index) =>
      customerRecord('c-' + String(index).padStart(4, '0')));
    const result = await new QboUnifiedMappingService(store).run();
    expect(result.customers.mapped).toBe(QBO_MAPPING_PAGE_SIZE + 1);
    expect(result.recordsProcessed).toBe(QBO_MAPPING_PAGE_SIZE + 1);
    expect([...store.runs.values()][0].status).toBe('COMPLETED');
  });
});
