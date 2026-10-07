import { logger } from '../../../utils/logger';
import { mapQboCustomer } from './customer.mapper';
import { mapQboInvoice } from './invoice.mapper';
import { mapQboPayment } from './payment.mapper';
import { KnexQboUnifiedMappingStore } from './qbo-unified-mapping.repository';
import {
  QBO_MAPPING_PAGE_SIZE,
  type MappingIssue,
  type ParsedSource,
  type QboMappingBatchResult,
  type QboMappingCounts,
  type QboRawEntity,
  type QboUnifiedMappingResult,
  type QboUnifiedMappingStore,
} from './mapping.types';
import type {
  QboCustomerProjection,
  QboInvoiceProjection,
  QboPaymentProjection,
} from './mapping.types';

interface EntityProgress {
  counts: QboMappingCounts;
  recordsProcessed: number;
  skippedByReason: QboUnifiedMappingResult['skippedByReason'];
  applicationMapped: number;
  applicationSkipped: number;
}

const emptyProgress = (): EntityProgress => ({
  counts: { mapped: 0, deleted: 0, skipped: 0 },
  recordsProcessed: 0,
  skippedByReason: {},
  applicationMapped: 0,
  applicationSkipped: 0,
});

const countIssues = (
  counts: QboUnifiedMappingResult['skippedByReason'],
  issues: MappingIssue[],
): void => {
  for (const issue of issues) counts[issue.reason] = (counts[issue.reason] ?? 0) + 1;
};

const safeErrorClass = (error: unknown): string => {
  if (!(error instanceof Error)) return 'UnknownError';
  return error.name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'UnknownError';
};

export class QboUnifiedMappingService {
  public constructor(private readonly store: QboUnifiedMappingStore = new KnexQboUnifiedMappingStore()) {}

  public async run(): Promise<QboUnifiedMappingResult> {
    let releaseLocks: (() => Promise<void>) | null = null;
    let syncRunId: string | null = null;
    let recordsProcessed = 0;
    let stage = 'acquire_locks';
    try {
      releaseLocks = await this.store.acquireLocks();
      if (!releaseLocks) throw new Error('QuickBooks unified mapping is already running or source sync is active.');

      stage = 'recover_stale_runs';
      await this.store.recoverStaleRuns();
      stage = 'create_sync_run';
      syncRunId = await this.store.createRun();

      stage = 'map_customers';
      const customers = await this.processEntity<QboCustomerProjection>(
        'Customers',
        mapQboCustomer,
        (records, deletedIds, issues) => this.store.persistCustomers(syncRunId!, records, deletedIds, issues),
      );
      recordsProcessed += customers.recordsProcessed;

      stage = 'map_invoices';
      const invoices = await this.processEntity<QboInvoiceProjection>(
        'Invoices',
        mapQboInvoice,
        (records, deletedIds, issues) => this.store.persistInvoices(syncRunId!, records, deletedIds, issues),
      );
      recordsProcessed += invoices.recordsProcessed;

      stage = 'map_payments_and_applications';
      const payments = await this.processEntity<QboPaymentProjection>(
        'Payments',
        mapQboPayment,
        (records, deletedIds, issues) => this.store.persistPayments(syncRunId!, records, deletedIds, issues),
      );
      recordsProcessed += payments.recordsProcessed;

      stage = 'map_payment_applications';
      const applications = await this.processPaymentApplications(syncRunId);

      stage = 'complete_sync_run';
      await this.store.completeRun(syncRunId, recordsProcessed);
      const skippedByReason: QboUnifiedMappingResult['skippedByReason'] = {};
      for (const progress of [customers, invoices, payments, applications]) {
        for (const [reason, count] of Object.entries(progress.skippedByReason)) {
          const typedReason = reason as keyof QboUnifiedMappingResult['skippedByReason'];
          skippedByReason[typedReason] = (skippedByReason[typedReason] ?? 0) + (count ?? 0);
        }
      }
      const result: QboUnifiedMappingResult = {
        syncRunId,
        recordsProcessed,
        customers: customers.counts,
        invoices: invoices.counts,
        payments: payments.counts,
        paymentApplications: {
          mapped: applications.applicationMapped,
          skipped: applications.applicationSkipped,
        },
        skippedByReason,
      };
      logger.info(
        '[QuickBooks Mapping] Completed; ' +
        'syncRunId=' + syncRunId +
        ', recordsProcessed=' + recordsProcessed +
        ', customerMapped=' + customers.counts.mapped +
        ', invoiceMapped=' + invoices.counts.mapped +
        ', paymentMapped=' + payments.counts.mapped +
        ', paymentApplicationsMapped=' + applications.applicationMapped +
        ', skipped=' + Object.values(skippedByReason).reduce((sum, count) => sum + (count ?? 0), 0),
      );
      return result;
    } catch (error) {
      if (syncRunId) {
        try {
          await this.store.failRun(
            syncRunId,
            'QuickBooks unified mapping failed during ' + stage + '.',
            recordsProcessed,
          );
        } catch {
          logger.error('[QuickBooks Mapping] Failed to mark the mapping run as failed; syncRunId=' + syncRunId);
        }
      }
      logger.error(
        '[QuickBooks Mapping] Synchronization failed; stage=' + stage +
        ', syncRunId=' + (syncRunId ?? 'not-created') +
        ', errorClass=' + safeErrorClass(error),
      );
      throw new Error('QuickBooks unified mapping failed during ' + stage + '.', { cause: error });
    } finally {
      if (releaseLocks) await releaseLocks();
    }
  }

  private async processEntity<T>(
    entity: QboRawEntity,
    mapper: (raw: Parameters<typeof mapQboCustomer>[0]) => ParsedSource<T>,
    persist: (
      records: T[],
      deletedIds: string[],
      issues: MappingIssue[],
    ) => Promise<QboMappingBatchResult>,
  ): Promise<EntityProgress> {
    const progress = emptyProgress();
    let afterSourceId: string | null = null;
    while (true) {
      const rawBatch = await this.store.loadLatestBatch(entity, afterSourceId, QBO_MAPPING_PAGE_SIZE);
      if (rawBatch.length === 0) break;
      const records: T[] = [];
      const deletedIds: string[] = [];
      const issues: MappingIssue[] = [];
      for (const raw of rawBatch) {
        const mapped = mapper(raw);
        if (mapped.kind === 'mapped') records.push(mapped.value);
        else if (mapped.kind === 'deleted') deletedIds.push(mapped.sourceId);
        else issues.push(mapped.issue);
      }

      const batch = await persist(records, deletedIds, issues);
      progress.counts.mapped += batch.mapped;
      progress.counts.deleted += batch.deleted;
      progress.counts.skipped += batch.skipped;
      progress.applicationMapped += batch.applicationMapped ?? 0;
      progress.applicationSkipped += batch.applicationSkipped ?? 0;
      countIssues(progress.skippedByReason, batch.issues);
      progress.recordsProcessed += rawBatch.length;
      afterSourceId = rawBatch[rawBatch.length - 1].source_id;
      if (rawBatch.length < QBO_MAPPING_PAGE_SIZE) break;
    }
    return progress;
  }

  private async processPaymentApplications(syncRunId: string): Promise<EntityProgress> {
    const progress = emptyProgress();
    let afterSourceId: string | null = null;
    while (true) {
      const rawBatch = await this.store.loadLatestBatch('Payments', afterSourceId, QBO_MAPPING_PAGE_SIZE);
      if (rawBatch.length === 0) break;
      const projections: QboPaymentProjection[] = [];
      for (const raw of rawBatch) {
        const mapped = mapQboPayment(raw);
        if (mapped.kind === 'mapped') projections.push(mapped.value);
      }
      const batch = await this.store.persistPaymentApplications(syncRunId, projections);
      progress.applicationMapped += batch.applicationMapped ?? 0;
      progress.applicationSkipped += batch.applicationSkipped ?? 0;
      countIssues(progress.skippedByReason, batch.issues);
      afterSourceId = rawBatch[rawBatch.length - 1].source_id;
      if (rawBatch.length < QBO_MAPPING_PAGE_SIZE) break;
    }
    return progress;
  }
}

export const qboUnifiedMappingService = new QboUnifiedMappingService();
