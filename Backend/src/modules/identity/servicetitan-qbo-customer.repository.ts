/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/array-type */
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../../database';
import { logger } from '../../utils/logger';
import {
  type CustomerIdentityAnalysis,
  type CustomerIdentityIssue,
  type CustomerIdentityPlan,
  type CustomerIdentityRepository,
  type CustomerIdentityRunResult,
  type IdentityRawCustomerRecord,
} from './customer-identity.types';

const RUN_SOURCE = 'ServiceTitanQuickBooks';
const RUN_ENTITY = 'CustomerIdentity';
export const IDENTITY_PERSIST_BATCH_SIZE = 500;
const LOCK_KEYS = [
  'QuickBooks:Customer',
  'QuickBooks:Customers',
  'QuickBooks:UnifiedMapping',
  'ServiceTitan:QuickBooks:CustomerIdentity',
  'trufinity:servicetitan:customer-ingestion',
] as const;

interface IdentityRow {
  id: string;
  source_system: string;
  source_id: string;
  unified_entity_id: string | null;
  confidence_level: string;
  matching_method: string | null;
  matched_by: string | null;
  status: string;
}

interface UnifiedCustomerRow {
  id: string;
  name: string | null;
  source_specific_data: unknown;
}

interface ResolvedPlan {
  plan: CustomerIdentityPlan;
  targetId: string;
  qboBacked: boolean;
  conflict: CustomerIdentityIssue | null;
  remapFrom: string | null;
  metadata: {
    confidence_level: string;
    matching_method: string | null;
    matched_by: string | null;
    status: string;
  };
}

const safeIssue = (sourceId: string, reason: CustomerIdentityIssue['reason']): CustomerIdentityIssue => ({
  sourceId,
  reason,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const runInBatches = async <T>(
  rows: T[],
  insertBatch: (batch: T[]) => Promise<void>,
  batchSize = IDENTITY_PERSIST_BATCH_SIZE,
): Promise<void> => {
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await insertBatch(rows.slice(offset, offset + batchSize));
  }
};

const parseSourceData = (value: unknown): Record<string, unknown> | null => {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error('Unified customer source_specific_data is malformed.');
  return value;
};

const mergeSourceNamespace = (
  existing: Record<string, unknown> | null,
  plan: CustomerIdentityPlan,
): Record<string, unknown> => {
  const current = existing?.servicetitan;
  const currentNamespace = isRecord(current) ? current : {};
  if (plan.kind === 'MERGED') {
    const mergedSources = isRecord(currentNamespace.mergedSources) ? { ...currentNamespace.mergedSources } : {};
    mergedSources[plan.sourceId] = plan.payload;
    return { ...currentNamespace, mergedSources };
  }
  return { ...currentNamespace, ...plan.payload };
};

export class PostgresServiceTitanQboCustomerIdentityRepository implements CustomerIdentityRepository {
  public constructor(private readonly database: Knex = db) {}

  public async acquireLocks(): Promise<(() => Promise<void>) | null> {
    const connection = await this.database.client.acquireConnection();
    const acquired: string[] = [];
    let disposed = false;
    const dispose = async (destroy: boolean): Promise<void> => {
      if (disposed) return;
      disposed = true;
      try {
        if (destroy) await this.database.client.destroyRawConnection(connection);
        else await this.database.client.releaseConnection(connection);
      } catch {
        logger.error('[ST-QBO Identity] Advisory connection cleanup failed.');
      }
    };
    const release = async (): Promise<void> => {
      let unlockFailed = false;
      for (const key of [...acquired].reverse()) {
        try {
          await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', [key]).connection(connection);
        } catch {
          unlockFailed = true;
          logger.error('[ST-QBO Identity] Advisory unlock failed; destroying lock connection.');
        }
      }
      await dispose(unlockFailed);
    };
    try {
      for (const key of [...LOCK_KEYS].sort()) {
        const result = await this.database.raw(
          'SELECT pg_try_advisory_lock(hashtext(?)) AS locked',
          [key],
        ).connection(connection);
        if (!Array.isArray(result.rows) || result.rows[0]?.locked !== true) {
          await release();
          return null;
        }
        acquired.push(key);
      }
    } catch (error) {
      await release();
      throw error;
    }
    return release;
  }

  public async recoverStaleRuns(): Promise<void> {
    await this.database('sync_runs')
      .where({ source_system: RUN_SOURCE, entity_type: RUN_ENTITY, status: 'RUNNING' })
      .update({
        status: 'FAILED',
        error_message: 'Recovered interrupted ServiceTitan/QBO customer identity run.',
        completed_at: this.database.fn.now(),
      });
  }

  public async createRun(): Promise<string> {
    const rows = await this.database('sync_runs')
      .insert({ source_system: RUN_SOURCE, entity_type: RUN_ENTITY, status: 'RUNNING' })
      .returning('id') as Array<{ id?: unknown }>;
    const id = rows[0]?.id;
    if (typeof id !== 'string') throw new Error('Unable to create customer identity run.');
    return id;
  }

  public async loadLatestCustomers(
    sourceSystem: 'ServiceTitan' | 'QuickBooks',
  ): Promise<IdentityRawCustomerRecord[]> {
    const table = sourceSystem === 'ServiceTitan' ? 'raw_st_customers' : 'raw_qbo_customers';
    const query = this.database(table)
      .select('source_id as sourceId', 'payload')
      .where({ is_latest: true });
    if (sourceSystem === 'QuickBooks') {
      query.select('is_deleted as isDeleted');
    } else {
      query.select(this.database.raw('false AS "isDeleted"'));
    }
    return await query as IdentityRawCustomerRecord[];
  }

  public async persist(
    runId: string,
    analysis: CustomerIdentityAnalysis,
  ): Promise<CustomerIdentityRunResult> {
    return await this.database.transaction(async (trx) => {
      const sourceIds = analysis.plans.map((plan) => plan.sourceId);
      const qboSourceIds = analysis.plans
        .map((plan) => plan.qboSourceId)
        .filter((id): id is string => id !== null);
      const lookupIds = [...new Set([...sourceIds, ...qboSourceIds])];
      const rows = lookupIds.length === 0
        ? []
        : await trx('identity_mappings')
          .select(
            'id', 'source_system', 'source_id', 'unified_entity_id',
            'confidence_level', 'matching_method', 'matched_by', 'status',
          )
          .where({ entity_type: 'Customer' })
          .where((query) => {
            query.where('source_system', 'QuickBooks').orWhere((serviceTitanQuery) => {
              serviceTitanQuery.where('source_system', 'ServiceTitan').whereIn('source_id', sourceIds);
            });
          }) as IdentityRow[];
      const byKey = new Map(rows.map((row) => [row.source_system + ':' + row.source_id, row]));
      const qboRows = new Map(qboSourceIds.map((sourceId) => [sourceId, byKey.get('QuickBooks:' + sourceId)]));
      const targetIds = [...new Set(rows.map((row) => row.unified_entity_id).filter((id): id is string => id !== null))];
      const targetRows = targetIds.length === 0
        ? []
        : await trx('unified_customers')
          .select('id', 'name', 'source_specific_data')
          .whereIn('id', targetIds) as UnifiedCustomerRow[];
      if (targetRows.length !== targetIds.length) throw new Error('Customer identity points to missing unified target.');
      const targetState = new Map(targetRows.map((row) => [row.id, row]));
      const qboTargetIds = new Set(
        rows
          .filter((row) => row.source_system === 'QuickBooks' && row.unified_entity_id !== null)
          .map((row) => row.unified_entity_id),
      );
      const resolved: ResolvedPlan[] = [];
      const issues: CustomerIdentityIssue[] = [...analysis.issues];

      for (const plan of analysis.plans.filter((item) => item.kind !== 'MERGED')) {
        const existing = byKey.get('ServiceTitan:' + plan.sourceId);
        const qboIdentity = plan.qboSourceId === null ? undefined : qboRows.get(plan.qboSourceId);
        const desiredQboTarget = qboIdentity?.status === 'ACTIVE' ? qboIdentity.unified_entity_id : null;
        let targetId = existing?.unified_entity_id ?? desiredQboTarget ?? randomUUID();
        let conflict: CustomerIdentityIssue | null = null;
        let remapFrom: string | null = null;

        if (existing?.confidence_level === 'VERIFIED') {
          if (desiredQboTarget !== null && existing.unified_entity_id !== desiredQboTarget) {
            conflict = safeIssue(plan.sourceId, 'EXISTING_VERIFIED_MAPPING_CONFLICT');
          }
          if (existing.unified_entity_id !== null) targetId = existing.unified_entity_id;
        } else if (existing?.status === 'MERGED') {
          conflict = safeIssue(plan.sourceId, 'EXISTING_VERIFIED_MAPPING_CONFLICT');
        } else if (
          desiredQboTarget !== null &&
          existing !== undefined &&
          existing.unified_entity_id !== null &&
          existing.unified_entity_id !== desiredQboTarget
        ) {
          remapFrom = existing.unified_entity_id;
          targetId = desiredQboTarget;
        } else if (desiredQboTarget !== null) {
          targetId = desiredQboTarget;
        }

        if (plan.kind === 'TIER_A' && desiredQboTarget === null) {
          issues.push(safeIssue(plan.sourceId, 'QBO_IDENTITY_NOT_FOUND'));
          targetId = existing?.unified_entity_id ?? randomUUID();
          remapFrom = null;
        }

        resolved.push({
          plan,
          targetId,
          qboBacked: qboTargetIds.has(targetId) && conflict === null,
          conflict,
          remapFrom,
          metadata: conflict !== null || existing?.confidence_level === 'VERIFIED'
            ? {
              confidence_level: existing?.confidence_level ?? 'VERIFIED',
              matching_method: existing?.matching_method ?? null,
              matched_by: existing?.matched_by ?? 'system',
              status: existing?.status ?? 'ACTIVE',
            }
            : plan.kind === 'TIER_A' && desiredQboTarget !== null
              ? {
                confidence_level: 'VERIFIED',
                matching_method: 'DETERMINISTIC_NAME_ZIP_ADDRESS_TIER_A',
                matched_by: 'system',
                status: 'ACTIVE',
              }
              : {
                confidence_level: 'UNRESOLVED',
                matching_method: null,
                matched_by: null,
                status: 'ACTIVE',
              },
        });
      }

      const resolvedBySource = new Map(resolved.map((item) => [item.plan.sourceId, item]));
      for (const plan of analysis.plans.filter((item) => item.kind === 'MERGED')) {
        const terminal = resolvedBySource.get(plan.terminalSourceId);
        if (!terminal) throw new Error('Merged customer terminal was not resolved.');
        const existing = byKey.get('ServiceTitan:' + plan.sourceId);
        let conflict: CustomerIdentityIssue | null = null;
        let targetId = terminal.targetId;
        if (existing?.confidence_level === 'VERIFIED' && existing.unified_entity_id !== targetId) {
          conflict = safeIssue(plan.sourceId, 'EXISTING_VERIFIED_MAPPING_CONFLICT');
          targetId = existing.unified_entity_id ?? targetId;
        } else if (existing?.status === 'MERGED') {
          if (existing.unified_entity_id !== null && existing.unified_entity_id !== targetId) {
            conflict = safeIssue(plan.sourceId, 'EXISTING_VERIFIED_MAPPING_CONFLICT');
            targetId = existing.unified_entity_id;
          }
        }
        resolved.push({
          plan,
          targetId,
          qboBacked: terminal.qboBacked,
          conflict,
          remapFrom: null,
          metadata: conflict !== null
            ? {
              confidence_level: existing?.confidence_level ?? 'VERIFIED',
              matching_method: existing?.matching_method ?? 'SERVICETITAN_MERGED_TO',
              matched_by: existing?.matched_by ?? 'system',
              status: existing?.status ?? 'ACTIVE',
            }
            : {
              confidence_level: 'VERIFIED',
              matching_method: 'SERVICETITAN_MERGED_TO',
              matched_by: 'system',
              status: 'MERGED',
            },
        });
      }

      const skippedByConflict = new Set(
        resolved.filter((item) => item.conflict !== null).map((item) => item.plan.sourceId),
      );
      issues.push(...resolved
        .filter((item) => item.conflict !== null)
        .map((item) => item.conflict!));

      for (const item of resolved.filter((entry) => entry.conflict === null && entry.remapFrom !== null)) {
        const oldTarget = item.remapFrom;
        if (oldTarget === null) continue;
        const currentIdentityId = byKey.get('ServiceTitan:' + item.plan.sourceId)?.id;
        const otherIdentity = await trx('identity_mappings')
          .where({ entity_type: 'Customer', unified_entity_id: oldTarget })
          .modify((query) => {
            if (currentIdentityId !== undefined) query.whereNot('id', currentIdentityId);
          })
          .first('id');
        if (otherIdentity !== undefined) {
          skippedByConflict.add(item.plan.sourceId);
          issues.push(safeIssue(item.plan.sourceId, 'IDENTITY_REMAP_UNSAFE'));
          continue;
        }
        await this.reassignCustomerReferences(trx, oldTarget, item.targetId);
      }

      const targetUpdates = new Map<string, { name: string | null; source_specific_data: Record<string, unknown> }>();
      for (const item of resolved) {
        if (skippedByConflict.has(item.plan.sourceId)) continue;
        const existingTarget = targetState.get(item.targetId);
        const previousUpdate = targetUpdates.get(item.targetId);
        const existingData = previousUpdate?.source_specific_data ?? parseSourceData(existingTarget?.source_specific_data ?? null);
        const data = { ...(existingData ?? {}) };
        data.servicetitan = mergeSourceNamespace(existingData, item.plan);
        const name = item.qboBacked
          ? (previousUpdate?.name ?? existingTarget?.name ?? item.plan.name)
          : (item.plan.kind === 'MERGED'
            ? (previousUpdate?.name ?? existingTarget?.name ?? null)
            : item.plan.name);
        targetUpdates.set(item.targetId, { name, source_specific_data: data });
      }

      for (const [targetId, update] of targetUpdates) {
        await trx('unified_customers')
          .insert({ id: targetId, name: update.name, source_specific_data: update.source_specific_data })
          .onConflict('id')
          .merge({ name: update.name, source_specific_data: update.source_specific_data, modified_on: trx.fn.now() });
      }

      const insertRows: Record<string, unknown>[] = [];
      for (const item of resolved) {
        if (skippedByConflict.has(item.plan.sourceId)) continue;
        const identity = byKey.get('ServiceTitan:' + item.plan.sourceId);
        const values = {
          unified_entity_id: item.targetId,
          confidence_level: item.metadata.confidence_level,
          matching_method: item.metadata.matching_method,
          matched_by: item.metadata.matched_by,
          status: item.metadata.status,
          modified_on: trx.fn.now(),
        };
        if (identity) {
          await trx('identity_mappings').where({ id: identity.id }).update(values);
        } else {
          insertRows.push({
            source_system: 'ServiceTitan',
            entity_type: 'Customer',
            source_id: item.plan.sourceId,
            ...values,
          });
        }
      }
      await runInBatches(insertRows, async (batch) => {
        await trx('identity_mappings').insert(batch);
      });
      await runInBatches(issues, async (batch) => {
        await this.insertIssues(trx, runId, batch);
      });

      const appliedPlans = resolved.filter((item) => !skippedByConflict.has(item.plan.sourceId));

      return {
        evaluated: analysis.evaluated,
        tierAVerifiedMatches: appliedPlans.filter((item) => item.plan.kind === 'TIER_A' && item.qboBacked).length,
        stOnlyUnresolved: appliedPlans.filter((item) => item.plan.kind === 'ST_ONLY' || (item.plan.kind === 'TIER_A' && !item.qboBacked)).length,
        mergedResolved: appliedPlans.filter((item) => item.plan.kind === 'MERGED').length,
        skipped: issues.filter((issue) => issue.reason === 'INVALID_SOURCE_PAYLOAD').length,
        conflicts: issues.filter((issue) => (
          issue.reason === 'EXISTING_VERIFIED_MAPPING_CONFLICT' ||
          issue.reason === 'IDENTITY_REMAP_UNSAFE'
        )).length,
        issues,
      };
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

  public async failRun(runId: string, safeMessage: string, recordsProcessed: number): Promise<void> {
    await this.database('sync_runs').where({ id: runId }).update({
      status: 'FAILED',
      records_processed: recordsProcessed,
      error_message: safeMessage.slice(0, 250),
      completed_at: this.database.fn.now(),
    });
  }

  private async reassignCustomerReferences(trx: Knex.Transaction, oldId: string, newId: string): Promise<void> {
    for (const table of [
      'canonical_locations',
      'canonical_jobs',
      'canonical_leads',
      'canonical_bookings',
      'unified_invoices',
      'unified_payments',
    ]) {
      await trx(table).where({ unified_customer_id: oldId }).update({ unified_customer_id: newId });
    }
  }

  private async insertIssues(trx: Knex.Transaction, runId: string, issues: CustomerIdentityIssue[]): Promise<void> {
    if (issues.length === 0) return;
    await trx('sync_errors').insert(issues.map((issue) => ({
      sync_run_id: runId,
      source_id: issue.sourceId,
      error_message: 'ST_QBO_CUSTOMER_IDENTITY:' + issue.reason,
      payload: null,
    })));
  }
}
