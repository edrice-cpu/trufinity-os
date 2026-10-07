import { logger } from '../../utils/logger';
import { analyzeCustomerIdentity } from './servicetitan-customer.mapper';
import { PostgresServiceTitanQboCustomerIdentityRepository } from './servicetitan-qbo-customer.repository';
import {
  type CustomerIdentityRepository,
  type CustomerIdentityRunResult,
} from './customer-identity.types';

const safeErrorClass = (error: unknown): string => {
  if (!(error instanceof Error)) return 'UnknownError';
  return error.name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'UnknownError';
};

export class ServiceTitanQboCustomerIdentityService {
  public constructor(
    private readonly repository: CustomerIdentityRepository = new PostgresServiceTitanQboCustomerIdentityRepository(),
  ) {}

  public async run(): Promise<CustomerIdentityRunResult> {
    let releaseLocks: (() => Promise<void>) | null = null;
    let runId: string | null = null;
    let stage = 'acquire_locks';
    let recordsProcessed = 0;

    try {
      releaseLocks = await this.repository.acquireLocks();
      if (!releaseLocks) {
        throw new Error('ServiceTitan/QBO customer identity mapping is already running or source sync is active.');
      }

      stage = 'recover_stale_runs';
      await this.repository.recoverStaleRuns();
      stage = 'create_sync_run';
      runId = await this.repository.createRun();
      stage = 'load_latest_customers';
      const [stCustomers, qboCustomers] = await Promise.all([
        this.repository.loadLatestCustomers('ServiceTitan'),
        this.repository.loadLatestCustomers('QuickBooks'),
      ]);
      recordsProcessed = stCustomers.length;

      stage = 'analyze_customer_identity';
      const analysis = analyzeCustomerIdentity(stCustomers, qboCustomers);
      stage = 'persist_customer_identity';
      const result = await this.repository.persist(runId, analysis);

      stage = 'complete_sync_run';
      await this.repository.completeRun(runId, recordsProcessed);
      logger.info(
        '[ST-QBO Customer Identity] Completed; ' +
        'evaluated=' + result.evaluated +
        ', tierAVerifiedMatches=' + result.tierAVerifiedMatches +
        ', stOnlyUnresolved=' + result.stOnlyUnresolved +
        ', mergedResolved=' + result.mergedResolved +
        ', conflicts=' + result.conflicts +
        ', skipped=' + result.skipped,
      );
      return result;
    } catch (error) {
      if (runId !== null) {
        try {
          await this.repository.failRun(
            runId,
            'ServiceTitan/QBO customer identity mapping failed during ' + stage + '.',
            recordsProcessed,
          );
        } catch {
          logger.error('[ST-QBO Customer Identity] Failed to mark run as failed; runId=' + runId);
        }
      }
      logger.error(
        '[ST-QBO Customer Identity] Synchronization failed; stage=' + stage +
        ', runId=' + (runId ?? 'not-created') +
        ', errorClass=' + safeErrorClass(error),
      );
      throw new Error(
        'ServiceTitan/QBO customer identity mapping failed during ' + stage + '.',
        { cause: error },
      );
    } finally {
      if (releaseLocks !== null) await releaseLocks();
    }
  }
}

export const serviceTitanQboCustomerIdentityService = new ServiceTitanQboCustomerIdentityService();

