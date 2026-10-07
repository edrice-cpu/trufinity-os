/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../../../database';
import { logger } from '../../../utils/logger';
import {
  QBO_MAPPING_LOCK_KEYS,
  type MappingIssue,
  type QboCustomerProjection,
  type QboInvoiceProjection,
  type QboMappingBatchResult,
  type QboPaymentProjection,
  type QboRawEntity,
  type QboUnifiedMappingStore,
  type RawQboRecord,
} from './mapping.types';
import { isJsonRecord } from './mapping.helpers';

type IdentityEntity = 'Customer' | 'Invoice' | 'Payment';
interface IdentityRow {
  id: string;
  source_id: string;
  unified_entity_id: string | null;
  status: string;
}
interface TargetState {
  id: string;
  source_specific_data: unknown;
}
interface IdentityState {
  bySourceId: Map<string, IdentityRow>;
  sourceSpecificDataByTargetId: Map<string, Record<string, unknown> | null>;
}

const RAW_TABLES: Record<QboRawEntity, string> = {
  Customers: 'raw_qbo_customers',
  Invoices: 'raw_qbo_invoices',
  Payments: 'raw_qbo_payments',
};

const mergeQboNamespace = (
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> => {
  if (existing === null) return incoming;
  return { ...existing, ...incoming };
};

const countIssues = (issues: MappingIssue[], entity: MappingIssue['entity']): number =>
  issues.filter((issue) => issue.entity === entity).length;

export class KnexQboUnifiedMappingStore implements QboUnifiedMappingStore {
  public constructor(private readonly database: Knex = db) {}

  public async acquireLocks(): Promise<(() => Promise<void>) | null> {
    const connection = await this.database.client.acquireConnection();
    const lockKeys = [...QBO_MAPPING_LOCK_KEYS].sort();
    const acquired: string[] = [];
    let disposed = false;

    const disposeConnection = async (destroy: boolean): Promise<void> => {
      if (disposed) return;
      disposed = true;
      try {
        if (destroy) await this.database.client.destroyRawConnection(connection);
        else await this.database.client.releaseConnection(connection);
      } catch {
        logger.error('[QuickBooks Mapping] Advisory connection cleanup failed.');
      }
    };
    const unlockAndDispose = async (): Promise<void> => {
      let unlockFailed = false;
      for (const lockKey of [...acquired].reverse()) {
        try {
          await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', [lockKey]).connection(connection);
        } catch {
          unlockFailed = true;
          logger.error('[QuickBooks Mapping] Advisory unlock failed; destroying the lock connection.');
        }
      }
      await disposeConnection(unlockFailed);
    };

    try {
      for (const lockKey of lockKeys) {
        const result = await this.database.raw(
          'SELECT pg_try_advisory_lock(hashtext(?)) AS locked',
          [lockKey],
        ).connection(connection);
        if (!Array.isArray(result.rows) || result.rows[0]?.locked !== true) {
          await unlockAndDispose();
          return null;
        }
        acquired.push(lockKey);
      }
    } catch (error) {
      await unlockAndDispose();
      throw error;
    }

    return async (): Promise<void> => {
      await unlockAndDispose();
    };
  }

  public async recoverStaleRuns(): Promise<void> {
    await this.database('sync_runs')
      .where({ source_system: 'QuickBooks', entity_type: 'UnifiedMapping', status: 'RUNNING' })
      .update({
        status: 'FAILED',
        error_message: 'Recovered interrupted QuickBooks unified mapping run.',
        completed_at: this.database.fn.now(),
      });
  }

  public async createRun(): Promise<string> {
    const rows = await this.database('sync_runs')
      .insert({ source_system: 'QuickBooks', entity_type: 'UnifiedMapping', status: 'RUNNING' })
      .returning('id');
    const runId: unknown = rows[0]?.id;
    if (typeof runId !== 'string') throw new Error('QuickBooks unified mapping run ID was not returned.');
    return runId;
  }

  public async loadLatestBatch(
    entity: QboRawEntity,
    afterSourceId: string | null,
    limit: number,
  ): Promise<RawQboRecord[]> {
    let query = this.database(RAW_TABLES[entity])
      .select('source_id', 'payload', 'is_deleted')
      .where({ is_latest: true })
      .orderBy('source_id', 'asc')
      .limit(limit);
    if (afterSourceId !== null) query = query.where('source_id', '>', afterSourceId);
    return await query as RawQboRecord[];
  }

  public async persistCustomers(
    runId: string,
    records: QboCustomerProjection[],
    deletedIds: string[],
    inputIssues: MappingIssue[],
  ): Promise<QboMappingBatchResult> {
    return this.database.transaction(async (trx) => {
      const issues = [...inputIssues];
      const state = await this.loadIdentityState(
        trx,
        'Customer',
        'unified_customers',
        [...records.map((record) => record.sourceId), ...deletedIds],
      );
      const deleted = await this.markDeleted(trx, state.bySourceId, deletedIds);
      const { targetRows, newMappings, activatedMappingIds } = records.reduce<{
        targetRows: Record<string, unknown>[];
        newMappings: Record<string, unknown>[];
        activatedMappingIds: string[];
      }>((accumulator, record) => {
        const identity = state.bySourceId.get(record.sourceId);
        const targetId = identity?.unified_entity_id ?? randomUUID();
        const existingData = state.sourceSpecificDataByTargetId.get(targetId) ?? null;
        accumulator.targetRows.push({
          id: targetId,
          name: record.name,
          source_specific_data: mergeQboNamespace(existingData, record.sourceSpecificData),
          modified_on: trx.fn.now(),
        });
        if (identity) accumulator.activatedMappingIds.push(identity.id);
        else accumulator.newMappings.push(this.newIdentity('Customer', record.sourceId, targetId));
        return accumulator;
      }, { targetRows: [], newMappings: [], activatedMappingIds: [] });
      this.assertUniqueTargetIds(targetRows, 'Customer');
      await this.upsertTargets(trx, 'unified_customers', targetRows, ['name', 'source_specific_data', 'modified_on']);
      await this.insertNewMappings(trx, newMappings);
      await this.activateMappings(trx, activatedMappingIds);
      await this.insertIssues(trx, runId, issues);
      return this.batchResult(records.length, deleted, issues, 0);
    });
  }

  public async persistInvoices(
    runId: string,
    records: QboInvoiceProjection[],
    deletedIds: string[],
    inputIssues: MappingIssue[],
  ): Promise<QboMappingBatchResult> {
    return this.database.transaction(async (trx) => {
      const issues = [...inputIssues];
      const invoiceState = await this.loadIdentityState(
        trx,
        'Invoice',
        'unified_invoices',
        [...records.map((record) => record.sourceId), ...deletedIds],
      );
      const customerIds = [...new Set(records.map((record) => record.customerSourceId))];
      const customerState = await this.loadIdentityState(trx, 'Customer', 'unified_customers', customerIds);
      const deleted = await this.markDeleted(trx, invoiceState.bySourceId, deletedIds);
      const accepted: QboInvoiceProjection[] = [];
      for (const record of records) {
        const customer = customerState.bySourceId.get(record.customerSourceId);
        if (!customer || customer.status === 'DELETED') {
          issues.push({ entity: 'Invoice', sourceId: record.sourceId, reason: 'CUSTOMER_IDENTITY_NOT_FOUND' });
          continue;
        }
        accepted.push(record);
      }

      const rows = accepted.map((record) => {
        const identity = invoiceState.bySourceId.get(record.sourceId);
        const targetId = identity?.unified_entity_id ?? randomUUID();
        const customerId = customerState.bySourceId.get(record.customerSourceId)?.unified_entity_id;
        if (!customerId) throw new Error('Resolved Customer identity has no unified target.');
        const existingData = invoiceState.sourceSpecificDataByTargetId.get(targetId) ?? null;
        return {
          row: {
            id: targetId,
            unified_customer_id: customerId,
            canonical_job_id: null,
            created_by_tech_id: null,
            status: null,
            total_amount: record.totalAmount,
            balance: record.balance,
            tax: record.tax,
            discount: record.discount,
            invoice_date: record.invoiceDate,
            due_date: record.dueDate,
            source_specific_data: mergeQboNamespace(existingData, record.sourceSpecificData),
            modified_on: trx.fn.now(),
          },
          identity,
          sourceId: record.sourceId,
          targetId,
        };
      });
      this.assertUniqueTargetIds(rows.map(({ row }) => row), 'Invoice');
      await this.upsertTargets(
        trx,
        'unified_invoices',
        rows.map(({ row }) => row),
        [
          'unified_customer_id', 'status', 'total_amount', 'balance', 'tax', 'discount',
          'invoice_date', 'due_date', 'source_specific_data', 'modified_on',
        ],
      );
      await this.insertNewMappings(trx, rows
        .filter(({ identity }) => !identity)
        .map(({ sourceId, targetId }) => this.newIdentity('Invoice', sourceId, targetId)));
      await this.activateMappings(trx, rows
        .filter(({ identity }) => identity)
        .map(({ identity }) => identity!.id));
      await this.insertIssues(trx, runId, issues);
      return this.batchResult(accepted.length, deleted, issues, 0);
    });
  }

  public async persistPayments(
    runId: string,
    records: QboPaymentProjection[],
    deletedIds: string[],
    inputIssues: MappingIssue[],
  ): Promise<QboMappingBatchResult> {
    return this.database.transaction(async (trx) => {
      const issues = [...inputIssues];
      const paymentState = await this.loadIdentityState(
        trx,
        'Payment',
        'unified_payments',
        [...records.map((record) => record.sourceId), ...deletedIds],
      );
      const customerIds = [...new Set(records.map((record) => record.customerSourceId))];
      const customerState = await this.loadIdentityState(trx, 'Customer', 'unified_customers', customerIds);
      const deleted = await this.markDeleted(trx, paymentState.bySourceId, deletedIds);
      const accepted: QboPaymentProjection[] = [];
      for (const record of records) {
        const customer = customerState.bySourceId.get(record.customerSourceId);
        if (!customer || customer.status === 'DELETED') {
          issues.push({ entity: 'Payment', sourceId: record.sourceId, reason: 'CUSTOMER_IDENTITY_NOT_FOUND' });
          continue;
        }
        accepted.push(record);
      }

      const rows = accepted.map((record) => {
        const identity = paymentState.bySourceId.get(record.sourceId);
        const targetId = identity?.unified_entity_id ?? randomUUID();
        const customerId = customerState.bySourceId.get(record.customerSourceId)?.unified_entity_id;
        if (!customerId) throw new Error('Resolved Customer identity has no unified target.');
        const existingData = paymentState.sourceSpecificDataByTargetId.get(targetId) ?? null;
        return {
          row: {
            id: targetId,
            unified_customer_id: customerId,
            applied_by_tech_id: null,
            status: null,
            type: null,
            total_amount: record.totalAmount,
            unapplied_amount: record.unappliedAmount,
            payment_date: record.paymentDate,
            source_specific_data: mergeQboNamespace(existingData, record.sourceSpecificData),
            modified_on: trx.fn.now(),
          },
          identity,
          sourceId: record.sourceId,
          targetId,
          record,
        };
      });
      this.assertUniqueTargetIds(rows.map(({ row }) => row), 'Payment');
      await this.upsertTargets(
        trx,
        'unified_payments',
        rows.map(({ row }) => row),
        [
          'unified_customer_id', 'status', 'type', 'total_amount', 'unapplied_amount',
          'payment_date', 'source_specific_data', 'modified_on',
        ],
      );
      await this.insertNewMappings(trx, rows
        .filter(({ identity }) => !identity)
        .map(({ sourceId, targetId }) => this.newIdentity('Payment', sourceId, targetId)));
      await this.activateMappings(trx, rows
        .filter(({ identity }) => identity)
        .map(({ identity }) => identity!.id));
      await this.insertIssues(trx, runId, issues);
      return this.batchResult(accepted.length, deleted, issues, 0);
    });
  }

  public async persistPaymentApplications(
    runId: string,
    records: QboPaymentProjection[],
  ): Promise<QboMappingBatchResult> {
    return this.database.transaction(async (trx) => {
      const issues = records.flatMap((record) => record.applicationIssues);
      const paymentIds = [...new Set(records.map((record) => record.sourceId))];
      const paymentState = await this.loadIdentityState(trx, 'Payment', 'unified_payments', paymentIds);
      const customerIds = [...new Set(records.map((record) => record.customerSourceId))];
      const customerState = await this.loadIdentityState(trx, 'Customer', 'unified_customers', customerIds);
      const invoiceIds = [...new Set(records.flatMap((record) =>
        record.applications.map((application) => application.invoiceSourceId)))];
      const invoiceState = await this.loadIdentityState(trx, 'Invoice', 'unified_invoices', invoiceIds);
      let applicationMapped = 0;

      for (const record of records) {
        const payment = paymentState.bySourceId.get(record.sourceId);
        if (payment?.status !== 'ACTIVE') {
          if (record.applications.length > 0) {
            issues.push({
              entity: 'PaymentApplication',
              sourceId: record.sourceId,
              reason: 'PAYMENT_IDENTITY_NOT_FOUND',
            });
          }
          continue;
        }
        if (!payment.unified_entity_id) {
          throw new Error('Resolved Payment identity has no unified target.');
        }

        const customer = customerState.bySourceId.get(record.customerSourceId);
        if (customer?.status !== 'ACTIVE') {
          if (record.applications.length > 0) {
            issues.push({
              entity: 'PaymentApplication',
              sourceId: record.sourceId,
              reason: 'CUSTOMER_IDENTITY_NOT_FOUND',
            });
          }
          continue;
        }

        // Parsing/validation issues mean the expected set is incomplete; keep the prior state intact.
        if (record.applicationIssues.length > 0) continue;

        const expectedRows: Record<string, unknown>[] = [];
        let complete = true;
        for (const application of record.applications) {
          const invoice = invoiceState.bySourceId.get(application.invoiceSourceId);
          if (invoice?.status !== 'ACTIVE') {
            issues.push({
              entity: 'PaymentApplication',
              sourceId: record.sourceId,
              reason: 'INVOICE_IDENTITY_NOT_FOUND',
            });
            complete = false;
            continue;
          }
          if (!invoice.unified_entity_id) {
            throw new Error('Resolved Invoice identity has no unified target.');
          }
          expectedRows.push({
            payment_id: payment.unified_entity_id,
            invoice_id: invoice.unified_entity_id,
            applied_amount: application.appliedAmount,
            applied_on: null,
          });
        }
        // An unresolved expected Invoice makes reconciliation incomplete: preserve all prior links.
        if (!complete) continue;

        const expectedInvoiceIds = expectedRows.map((row) => row.invoice_id as string);
        if (expectedRows.length > 0) {
          await trx('unified_payment_applications')
            .insert(expectedRows)
            .onConflict(['payment_id', 'invoice_id'])
            .merge(['applied_amount', 'applied_on']);
        }

        // This delete is strictly scoped to this ACTIVE QBO Payment and runs in the same transaction.
        let staleRows = trx('unified_payment_applications')
          .where({ payment_id: payment.unified_entity_id });
        if (expectedInvoiceIds.length > 0) {
          staleRows = staleRows.whereNotIn('invoice_id', expectedInvoiceIds);
        }
        await staleRows.delete();
        applicationMapped += expectedRows.length;
      }

      await this.insertIssues(trx, runId, issues);
      return this.batchResult(0, 0, issues, applicationMapped);
    });
  }

  public async completeRun(runId: string, recordsProcessed: number): Promise<void> {
    await this.database('sync_runs').where({ id: runId }).update({
      status: 'COMPLETED',
      records_processed: recordsProcessed,
      error_message: null,
      completed_at: this.database.fn.now(),
    });
  }

  public async failRun(runId: string, message: string, recordsProcessed: number): Promise<void> {
    await this.database('sync_runs').where({ id: runId }).update({
      status: 'FAILED',
      records_processed: recordsProcessed,
      error_message: message.slice(0, 250),
      completed_at: this.database.fn.now(),
    });
  }

  private async loadIdentityState(
    trx: Knex.Transaction,
    entity: IdentityEntity,
    targetTable: string,
    sourceIds: string[],
  ): Promise<IdentityState> {
    const uniqueIds = [...new Set(sourceIds)];
    if (uniqueIds.length === 0) return { bySourceId: new Map(), sourceSpecificDataByTargetId: new Map() };
    const rows = await trx('identity_mappings')
      .select('id', 'source_id', 'unified_entity_id', 'status')
      .where({ source_system: 'QuickBooks', entity_type: entity })
      .whereIn('source_id', uniqueIds) as IdentityRow[];
    const bySourceId = new Map(rows.map((row) => [row.source_id, row]));
    const targetIds = [...new Set(rows.map((row) => row.unified_entity_id).filter((id): id is string => id !== null))];
    if (rows.some((row) => row.unified_entity_id === null)) {
      throw new Error(entity + ' identity mapping has a null unified target.');
    }
    const targetRows = targetIds.length > 0
      ? await trx(targetTable).select('id', 'source_specific_data').whereIn('id', targetIds) as TargetState[]
      : [];
    const sourceSpecificDataByTargetId = new Map<string, Record<string, unknown> | null>();
    for (const target of targetRows) {
      if (target.source_specific_data !== null && !isJsonRecord(target.source_specific_data)) {
        throw new Error(entity + ' unified target has invalid source-specific data.');
      }
      sourceSpecificDataByTargetId.set(target.id, target.source_specific_data);
    }
    if (targetRows.length !== targetIds.length) {
      throw new Error(entity + ' identity mapping points to a missing unified target.');
    }
    return { bySourceId, sourceSpecificDataByTargetId };
  }

  private async markDeleted(
    trx: Knex.Transaction,
    bySourceId: Map<string, IdentityRow>,
    deletedIds: string[],
  ): Promise<number> {
    const identities = [...new Set(deletedIds)]
      .map((sourceId) => bySourceId.get(sourceId))
      .filter((identity): identity is IdentityRow => identity !== undefined);
    if (identities.length > 0) {
      await trx('identity_mappings').whereIn('id', identities.map(({ id }) => id)).update({
        status: 'DELETED',
        modified_on: trx.fn.now(),
      });
    }
    return identities.length;
  }

  private newIdentity(
    entity: IdentityEntity,
    sourceId: string,
    unifiedEntityId: string,
  ): Record<string, unknown> {
    return {
      source_system: 'QuickBooks',
      entity_type: entity,
      source_id: sourceId,
      unified_entity_id: unifiedEntityId,
      confidence_level: 'UNRESOLVED',
      matching_method: null,
      status: 'ACTIVE',
      matched_by: null,
      notes: null,
    };
  }

  private async insertNewMappings(trx: Knex.Transaction, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length > 0) await trx('identity_mappings').insert(rows);
  }

  private async activateMappings(trx: Knex.Transaction, identityIds: string[]): Promise<void> {
    if (identityIds.length > 0) {
      await trx('identity_mappings').whereIn('id', identityIds).update({
        status: 'ACTIVE',
        modified_on: trx.fn.now(),
      });
    }
  }

  private async upsertTargets(
    trx: Knex.Transaction,
    table: string,
    rows: Record<string, unknown>[],
    mergeColumns: string[],
  ): Promise<void> {
    if (rows.length > 0) await trx(table).insert(rows).onConflict('id').merge(mergeColumns);
  }

  private assertUniqueTargetIds(rows: Record<string, unknown>[], entity: IdentityEntity): void {
    const ids = rows.map((row) => row.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(entity + ' source identities resolve to the same unified target.');
    }
  }

  private async insertIssues(trx: Knex.Transaction, runId: string, issues: MappingIssue[]): Promise<void> {
    if (issues.length === 0) return;
    await trx('sync_errors').insert(issues.map((issue) => ({
      sync_run_id: runId,
      source_id: issue.sourceId,
      error_message: 'QBO_MAPPING:' + issue.entity + ':' + issue.reason,
      payload: null,
    })));
  }

  private batchResult(
    mapped: number,
    deleted: number,
    issues: MappingIssue[],
    applicationMapped: number,
  ): QboMappingBatchResult {
    return {
      mapped,
      deleted,
      skipped: countIssues(issues, 'Customer') + countIssues(issues, 'Invoice') + countIssues(issues, 'Payment'),
      applicationMapped,
      applicationSkipped: countIssues(issues, 'PaymentApplication'),
      issues,
    };
  }
}
