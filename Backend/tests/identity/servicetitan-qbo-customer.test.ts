import { describe, expect, it } from '@jest/globals';
import { analyzeCustomerIdentity, normalizeIdentityValue } from '../../src/modules/identity/servicetitan-customer.mapper';
import { ServiceTitanQboCustomerIdentityService } from '../../src/modules/identity/servicetitan-qbo-customer.service';
import { runInBatches } from '../../src/modules/identity/servicetitan-qbo-customer.repository';
import {
  type CustomerIdentityAnalysis,
  type CustomerIdentityRepository,
  type CustomerIdentityRunResult,
  type IdentityRawCustomerRecord,
} from '../../src/modules/identity/customer-identity.types';

const st = (id: string, extra: Record<string, unknown> = {}): IdentityRawCustomerRecord => ({
  sourceId: id,
  isDeleted: false,
  payload: {
    id: Number(id),
    name: 'Acme Plumbing',
    address: { street: '123 Main St', city: 'Toronto', state: 'ON', zip: 'M4B 1B3' },
    ...extra,
  },
});

const qbo = (id: string, extra: Record<string, unknown> = {}): IdentityRawCustomerRecord => ({
  sourceId: id,
  isDeleted: false,
  payload: {
    Id: id,
    DisplayName: 'Acme Plumbing',
    BillAddr: { Line1: '123 Main St', City: 'Toronto', CountrySubDivisionCode: 'ON', PostalCode: 'M4B 1B3' },
    ...extra,
  },
});

class MemoryRepository implements CustomerIdentityRepository {
  public stRecords: IdentityRawCustomerRecord[] = [];
  public qboRecords: IdentityRawCustomerRecord[] = [];
  public identities = new Map<string, { targetId: string; confidence: string; status: string; method: string | null }>();
  public customers = new Map<string, { name: string | null; data: Record<string, unknown> }>();
  public references: string[] = [];
  public failed = false;
  public runs: { status: string; records: number; error: string | null }[] = [];
  private nextId = 1;

  public async acquireLocks(): Promise<(() => Promise<void>) | null> {
    return async () => undefined;
  }

  public async recoverStaleRuns(): Promise<void> {}

  public async createRun(): Promise<string> {
    this.runs.push({ status: 'RUNNING', records: 0, error: null });
    return 'run-1';
  }

  public async loadLatestCustomers(sourceSystem: 'ServiceTitan' | 'QuickBooks'): Promise<IdentityRawCustomerRecord[]> {
    return sourceSystem === 'ServiceTitan' ? this.stRecords : this.qboRecords;
  }

  public async persist(_runId: string, analysis: CustomerIdentityAnalysis): Promise<CustomerIdentityRunResult> {
    if (this.failed) throw new Error('simulated persistence failure');
    const issues = [...analysis.issues];
    const historicalQboTargets = new Set(
      [...this.identities.entries()]
        .filter(([key, identity]) => key.startsWith('QuickBooks:') && identity.targetId !== '')
        .map(([, identity]) => identity.targetId),
    );
    let conflicts = 0;
    let tierA = 0;
    let unresolved = 0;
    let merged = 0;
    const orderedPlans = [
      ...analysis.plans.filter((plan) => plan.kind !== 'MERGED'),
      ...analysis.plans.filter((plan) => plan.kind === 'MERGED'),
    ];
    for (const plan of orderedPlans) {
      const key = 'ServiceTitan:' + plan.sourceId;
      const existing = this.identities.get(key);
      const qbo = plan.qboSourceId === null ? undefined : this.identities.get('QuickBooks:' + plan.qboSourceId);
      const desired = plan.kind === 'TIER_A' && qbo ? qbo.targetId : plan.kind === 'MERGED'
        ? this.identities.get('ServiceTitan:' + plan.terminalSourceId)?.targetId
        : existing?.targetId ?? 'st-' + this.nextId++;
      if (!desired) throw new Error('terminal target missing');
      if (existing?.confidence === 'VERIFIED') {
        if (existing.targetId !== desired) {
          issues.push({ sourceId: plan.sourceId, reason: 'EXISTING_VERIFIED_MAPPING_CONFLICT' });
          conflicts += 1;
          continue;
        }
      }
      if (existing?.targetId && existing.targetId !== desired) {
        this.references = this.references.map((id) => id === existing.targetId ? desired : id);
      }
      const current = this.customers.get(desired);
      const data = { ...(current?.data ?? {}) };
      const namespace = { ...((data.servicetitan as Record<string, unknown> | undefined) ?? {}) };
      if (plan.kind === 'MERGED') {
        const mergedSources = { ...((namespace.mergedSources as Record<string, unknown> | undefined) ?? {}) };
        mergedSources[plan.sourceId] = plan.payload;
        data.servicetitan = { ...namespace, mergedSources };
        merged += 1;
      } else {
        data.servicetitan = { ...namespace, ...plan.payload };
        if (plan.kind === 'TIER_A') tierA += 1;
        else unresolved += 1;
      }
      this.customers.set(desired, {
        name: (qbo?.targetId || historicalQboTargets.has(desired))
          ? (current?.name ?? plan.name)
          : (plan.kind === 'MERGED' ? current?.name ?? null : plan.name),
        data,
      });
      this.identities.set(key, {
        targetId: desired,
        confidence: existing?.confidence === 'VERIFIED' ? existing.confidence : plan.kind === 'TIER_A' ? 'VERIFIED' : plan.kind === 'MERGED' ? 'VERIFIED' : 'UNRESOLVED',
        status: existing?.confidence === 'VERIFIED' ? existing.status : plan.kind === 'MERGED' ? 'MERGED' : 'ACTIVE',
        method: existing?.confidence === 'VERIFIED' ? existing.method : plan.kind === 'TIER_A' ? 'DETERMINISTIC_NAME_ZIP_ADDRESS_TIER_A' : plan.kind === 'MERGED' ? 'SERVICETITAN_MERGED_TO' : null,
      });
    }
    return { evaluated: analysis.evaluated, tierAVerifiedMatches: tierA, stOnlyUnresolved: unresolved, mergedResolved: merged, skipped: issues.length, conflicts, issues };
  }

  public async completeRun(_runId: string, records: number): Promise<void> {
    this.runs[0].status = 'COMPLETED';
    this.runs[0].records = records;
  }

  public async failRun(_runId: string, error: string, records: number): Promise<void> {
    this.runs[0].status = 'FAILED';
    this.runs[0].records = records;
    this.runs[0].error = error;
  }
}

describe('ServiceTitan/QBO customer identity analysis', () => {
  it('persists rows in multiple safe batches and stops on a failed batch', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => index);
    const batches: number[][] = [];
    await runInBatches(rows, async (batch) => {
      batches.push(batch);
    });
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 1]);

    const attempted: number[][] = [];
    await expect(runInBatches(rows, async (batch) => {
      attempted.push(batch);
      if (attempted.length === 2) throw new Error('batch failure');
    })).rejects.toThrow('batch failure');
    expect(attempted.map((batch) => batch.length)).toEqual([500, 500]);
  });

  it('performs exact Tier-A matching and preserves the approved normalization rule', () => {
    expect(normalizeIdentityValue('  ACME Plumbing, Inc. ')).toBe('acmeplumbinginc');
    const result = analyzeCustomerIdentity([st('1')], [qbo('q1')]);
    expect(result.tierAVerifiedMatches).toBe(1);
    expect(result.plans[0]).toMatchObject({ kind: 'TIER_A', qboSourceId: 'q1' });
  });

  it('accepts punctuation and case differences but does not add fuzzy equivalence', () => {
    const result = analyzeCustomerIdentity(
      [st('1', { name: 'Acme-Plumbing, Inc', address: { street: '123 Main Street', city: 'Toronto', state: 'ON', zip: 'M4B-1B3' } })],
      [qbo('q1', { DisplayName: 'ACME Plumbing Inc', BillAddr: { Line1: '123 Main Street', City: 'Toronto', CountrySubDivisionCode: 'ON', PostalCode: 'M4B 1B3' } })],
    );
    expect(result.tierAVerifiedMatches).toBe(1);
  });

  it.each([
    [qbo('q1'), qbo('q2')],
    [qbo('q1', { BillAddr: { Line1: '999 Main St', City: 'Toronto', CountrySubDivisionCode: 'ON', PostalCode: 'M4B 1B3' } })],
  ])('does not Tier-A match ambiguous or conflicting candidates', (...qboRecords) => {
    const result = analyzeCustomerIdentity([st('1')], qboRecords);
    expect(result.tierAVerifiedMatches).toBe(0);
    expect(result.plans[0].kind).toBe('ST_ONLY');
  });

  it.each([
    { field: 'street', address: { street: '999 Main St', city: 'Toronto', state: 'ON', zip: 'M4B 1B3' } },
    { field: 'city', address: { street: '123 Main St', city: 'Ottawa', state: 'ON', zip: 'M4B 1B3' } },
    { field: 'state', address: { street: '123 Main St', city: 'Toronto', state: 'QC', zip: 'M4B 1B3' } },
    { field: 'missing', address: { street: '123 Main St', city: 'Toronto', state: undefined, zip: 'M4B 1B3' } },
  ])('$field conflicts or missing address evidence prevents Tier-A', ({ address }) => {
    const result = analyzeCustomerIdentity([st('1', { address })], [qbo('q1')]);
    expect(result.tierAVerifiedMatches).toBe(0);
    expect(result.plans[0].kind).toBe('ST_ONLY');
  });

  it('keeps inactive and do-not-service customers eligible for representation', () => {
    const result = analyzeCustomerIdentity([st('1', { active: false, doNotService: true, doNotMail: true })], []);
    expect(result.stOnlyUnresolved).toBe(1);
    expect(result.plans[0].kind).toBe('ST_ONLY');
  });

  it('creates and reuses an ST-only identity, preserves ST data, and is idempotent', async () => {
    const repository = new MemoryRepository();
    repository.stRecords = [st('1')];
    const service = new ServiceTitanQboCustomerIdentityService(repository);
    const first = await service.run();
    const target = repository.identities.get('ServiceTitan:1')?.targetId;
    expect(first.stOnlyUnresolved).toBe(1);
    expect(target).toBeDefined();
    expect(repository.customers.get(target!)?.data.servicetitan).toMatchObject({ name: 'Acme Plumbing' });
    await service.run();
    expect(repository.identities.get('ServiceTitan:1')?.targetId).toBe(target);
    expect(repository.customers.size).toBe(1);
  });

  it('reuses the QBO unified customer without overwriting its common name or namespace', async () => {
    const repository = new MemoryRepository();
    repository.stRecords = [st('1')];
    repository.qboRecords = [qbo('q1')];
    repository.identities.set('QuickBooks:q1', { targetId: 'qbo-target', confidence: 'UNRESOLVED', status: 'ACTIVE', method: null });
    repository.customers.set('qbo-target', { name: 'QBO Controlled Name', data: { quickbooks: { DisplayName: 'ACME' } } });
    await new ServiceTitanQboCustomerIdentityService(repository).run();
    const identity = repository.identities.get('ServiceTitan:1');
    expect(identity).toMatchObject({ targetId: 'qbo-target', confidence: 'VERIFIED', status: 'ACTIVE', method: 'DETERMINISTIC_NAME_ZIP_ADDRESS_TIER_A' });
    expect(repository.customers.get('qbo-target')).toMatchObject({ name: 'QBO Controlled Name', data: { quickbooks: { DisplayName: 'ACME' }, servicetitan: { name: 'Acme Plumbing' } } });
  });

  it('resolves direct and two-hop merges and converges multiple sources without creating targets', () => {
    const result = analyzeCustomerIdentity(
      [st('10', { mergedToId: 20, active: false }), st('20', { mergedToId: 30, active: false }), st('21', { mergedToId: 30, active: false }), st('30')],
      [],
    );
    expect(result.mergedResolved).toBe(3);
    expect(result.plans.filter((plan) => plan.kind === 'MERGED').map((plan) => plan.terminalSourceId)).toEqual(['30', '30', '30']);
  });

  it('fails safely for merge cycles, missing targets, and malformed merge identifiers', () => {
    expect(() => analyzeCustomerIdentity([st('1', { mergedToId: 2 })], [])).toThrow('MERGE_TARGET_NOT_FOUND');
    expect(() => analyzeCustomerIdentity([st('1', { mergedToId: 2 }), st('2', { mergedToId: 1 })], [])).toThrow('MERGE_CYCLE');
    expect(() => analyzeCustomerIdentity([st('1', { mergedToId: 'not-an-id' })], [])).toThrow('INVALID_MERGED_TO_ID');
  });

  it('marks merged sources as lineage records and never gives them independent targets', async () => {
    const repository = new MemoryRepository();
    repository.stRecords = [st('1', { mergedToId: 2, active: false }), st('2')];
    const service = new ServiceTitanQboCustomerIdentityService(repository);
    await service.run();
    const terminal = repository.identities.get('ServiceTitan:2');
    const merged = repository.identities.get('ServiceTitan:1');
    expect(terminal?.targetId).toBe(merged?.targetId);
    expect(merged).toMatchObject({ confidence: 'VERIFIED', status: 'MERGED', method: 'SERVICETITAN_MERGED_TO' });
  });

  it('does not silently remap an existing verified identity and surfaces a conflict', async () => {
    const repository = new MemoryRepository();
    repository.stRecords = [st('1')];
    repository.qboRecords = [qbo('q1')];
    repository.identities.set('QuickBooks:q1', { targetId: 'qbo-target', confidence: 'UNRESOLVED', status: 'ACTIVE', method: null });
    repository.identities.set('ServiceTitan:1', { targetId: 'old-target', confidence: 'VERIFIED', status: 'ACTIVE', method: 'MANUAL' });
    repository.customers.set('old-target', { name: 'Existing', data: {} });
    const result = await new ServiceTitanQboCustomerIdentityService(repository).run();
    expect(result.conflicts).toBe(1);
    expect(repository.identities.get('ServiceTitan:1')?.targetId).toBe('old-target');
  });

  it('preserves an existing verified identity when current evidence has no QBO candidate', async () => {
    const repository = new MemoryRepository();
    repository.stRecords = [st('1')];
    repository.identities.set('ServiceTitan:1', { targetId: 'existing-target', confidence: 'VERIFIED', status: 'ACTIVE', method: 'MANUAL_VERIFIED' });
    repository.customers.set('existing-target', { name: 'Existing', data: {} });
    const result = await new ServiceTitanQboCustomerIdentityService(repository).run();
    expect(result.conflicts).toBe(0);
    expect(repository.identities.get('ServiceTitan:1')).toEqual({ targetId: 'existing-target', confidence: 'VERIFIED', status: 'ACTIVE', method: 'MANUAL_VERIFIED' });
  });

  it('preserves the common name of a historically QBO-backed target after QBO deactivation', async () => {
    const repository = new MemoryRepository();
    repository.stRecords = [st('1')];
    repository.identities.set('ServiceTitan:1', { targetId: 'qbo-target', confidence: 'VERIFIED', status: 'ACTIVE', method: 'MANUAL_VERIFIED' });
    repository.identities.set('QuickBooks:q1', { targetId: 'qbo-target', confidence: 'UNRESOLVED', status: 'DELETED', method: null });
    repository.customers.set('qbo-target', { name: 'QBO Historical Name', data: { quickbooks: { DisplayName: 'QBO Historical Name' } } });

    await new ServiceTitanQboCustomerIdentityService(repository).run();

    expect(repository.customers.get('qbo-target')).toEqual({
      name: 'QBO Historical Name',
      data: {
        quickbooks: { DisplayName: 'QBO Historical Name' },
        servicetitan: expect.objectContaining({ name: 'Acme Plumbing' }),
      },
    });
  });

  it('safely transitions an unresolved ST-only identity and moves child references', async () => {
    const repository = new MemoryRepository();
    repository.stRecords = [st('1')];
    repository.identities.set('ServiceTitan:1', { targetId: 'old-target', confidence: 'UNRESOLVED', status: 'ACTIVE', method: null });
    repository.customers.set('old-target', { name: 'Old', data: { servicetitan: { old: true } } });
    repository.references = ['old-target'];
    repository.qboRecords = [qbo('q1')];
    repository.identities.set('QuickBooks:q1', { targetId: 'qbo-target', confidence: 'UNRESOLVED', status: 'ACTIVE', method: null });
    repository.customers.set('qbo-target', { name: 'QBO', data: { quickbooks: {} } });
    await new ServiceTitanQboCustomerIdentityService(repository).run();
    expect(repository.identities.get('ServiceTitan:1')?.targetId).toBe('qbo-target');
    expect(repository.references).toEqual(['qbo-target']);
  });

  it('keeps duplicate and idempotent identities safe and rolls back on persistence failure', async () => {
    const repository = new MemoryRepository();
    repository.stRecords = [st('1'), st('1')];
    repository.failed = true;
    await expect(new ServiceTitanQboCustomerIdentityService(repository).run()).rejects.toThrow();
    expect(repository.identities.size).toBe(0);
    expect(repository.customers.size).toBe(0);
    expect(repository.runs[0].status).toBe('FAILED');
  });
});
