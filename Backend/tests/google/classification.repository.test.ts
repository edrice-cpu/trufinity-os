import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { ClassificationPersistenceError, KnexEmailClassificationRepository, computeResolutionDeadline, evaluateSlaState } from '../../src/modules/google/classification.repository';

const input = {
  mailboxId: 'mailbox-1', mailboxAddress: 'service@trufinity.ca', providerMessageId: 'message-1',
  classification: { label: 'complaint' as const, confidence: 0.9, reason: 'Synthetic reason.' },
  decisionStatus: 'ESCALATION' as const, modelProvider: 'anthropic', modelName: 'model', promptVersion: 'v1', idempotencyKey: 'event-1',
};

function fakeDatabase(options: { failWorkItem?: boolean; duplicate?: boolean } = {}) {
  const classifications: Array<{ id: string }> = options.duplicate ? [] : [{ id: 'classification-1' }];
  const workItems: Array<{ id: string }> = [];
  const capturedWorkItemInserts: unknown[] = [];
  const trx = jest.fn((table: string) => {
    const builder: any = {
      insert: jest.fn((data: unknown) => { if (table === 'email_escalation_work_items') capturedWorkItemInserts.push(data); return builder; }),
      onConflict: jest.fn(() => builder),
      ignore: jest.fn(() => builder),
      returning: jest.fn(async () => {
        if (table === 'email_classification_results') return classifications;
        if (options.failWorkItem) throw new Error('work item failure');
        workItems.push({ id: 'work-1' }); return workItems;
      }),
      select: jest.fn(() => builder),
      where: jest.fn(() => builder),
      first: jest.fn(async () => table === 'email_classification_results' ? { id: 'classification-existing' } : { id: 'work-existing' }),
    };
    return builder;
  }) as any;
  const database = { transaction: async (work: (transaction: unknown) => Promise<unknown>) => work(trx) } as any;
  return { database, trx, workItems, capturedWorkItemInserts };
}

describe('KnexEmailClassificationRepository', () => {
  it('persists a classification and escalation work item atomically', async () => {
    const { database, trx, capturedWorkItemInserts } = fakeDatabase();
    const result = await new KnexEmailClassificationRepository(database).persist(input);
    expect(result).toEqual({ id: 'classification-1', workItemId: 'work-1', duplicate: false });
    expect(trx).toHaveBeenCalledWith('email_classification_results');
    expect(trx).toHaveBeenCalledWith('email_escalation_work_items');
    expect(capturedWorkItemInserts).toHaveLength(1);
    expect(capturedWorkItemInserts[0]).toMatchObject({
      classification_result_id: 'classification-1',
      work_type: 'ESCALATION',
      sla_state: 'ON_TRACK',
    });
    expect((capturedWorkItemInserts[0] as any).resolution_deadline).toBeInstanceOf(Date);
  });

  it('does not create a work item for NONE', async () => {
    const { database, trx, capturedWorkItemInserts } = fakeDatabase();
    const result = await new KnexEmailClassificationRepository(database).persist({ ...input, decisionStatus: 'NONE', idempotencyKey: 'event-none' });
    expect(result.workItemId).toBeNull();
    expect(trx).not.toHaveBeenCalledWith('email_escalation_work_items');
    expect(capturedWorkItemInserts).toHaveLength(0);
  });

  it('handles duplicate idempotency keys without creating duplicate history/work', async () => {
    const { database, trx, capturedWorkItemInserts } = fakeDatabase({ duplicate: true });
    const result = await new KnexEmailClassificationRepository(database).persist(input);
    expect(result.duplicate).toBe(true);
    expect(result.id).toBe('classification-existing');
    expect(trx).not.toHaveBeenCalledWith('email_escalation_work_items');
    expect(capturedWorkItemInserts).toHaveLength(0);
  });

  it('propagates work-item failure wrapped in ClassificationPersistenceError', async () => {
    const { database } = fakeDatabase({ failWorkItem: true });
    await expect(new KnexEmailClassificationRepository(database).persist(input)).rejects.toThrow(ClassificationPersistenceError);
    try {
      await new KnexEmailClassificationRepository(database).persist(input);
    } catch (error) {
      expect(error).toBeInstanceOf(ClassificationPersistenceError);
      expect((error as ClassificationPersistenceError).stage).toBe('work_item_persistence');
    }
  });

  it('persists REVIEW_REQUIRED work item with correct work_type', async () => {
    const { database, capturedWorkItemInserts } = fakeDatabase();
    const result = await new KnexEmailClassificationRepository(database).persist({ ...input, decisionStatus: 'REVIEW_REQUIRED', idempotencyKey: 'event-review' });
    expect(result.workItemId).toBe('work-1');
    expect(capturedWorkItemInserts).toHaveLength(1);
    expect(capturedWorkItemInserts[0]).toMatchObject({
      classification_result_id: 'classification-1',
      work_type: 'REVIEW_REQUIRED',
      sla_state: 'ON_TRACK',
    });
    expect((capturedWorkItemInserts[0] as any).resolution_deadline).toBeInstanceOf(Date);
  });

  it('does not define prohibited email-content fields in the persistence migration', () => {
    const migration = fs.readFileSync(path.resolve(__dirname, '../../migrations/20260928120000_013_google_gmail_classifier_foundation.ts'), 'utf8');
    for (const prohibited of ["table.string('body'", "table.string('html'", "table.string('snippet'", "table.string('raw_mime'", "table.string('attachment_binary'", "table.string('provider_response'"]) {
      expect(migration.toLowerCase()).not.toContain(prohibited);
    }
  });
});

describe('computeResolutionDeadline', () => {
  const base = new Date('2026-09-01T12:00:00Z');

  it('ESCALATION adds 12 hours', () => {
    const deadline = computeResolutionDeadline('ESCALATION', base);
    expect(deadline.getTime()).toBe(base.getTime() + 12 * 60 * 60 * 1000);
  });

  it('REVIEW_REQUIRED adds 24 hours', () => {
    const deadline = computeResolutionDeadline('REVIEW_REQUIRED', base);
    expect(deadline.getTime()).toBe(base.getTime() + 24 * 60 * 60 * 1000);
  });
});

describe('evaluateSlaState', () => {
  const deadline = new Date('2026-09-02T00:00:00Z');

  it('returns UNCONFIGURED when no deadline', () => {
    expect(evaluateSlaState(false, null, null)).toBe('UNCONFIGURED');
  });

  it('returns ON_TRACK when before deadline', () => {
    expect(evaluateSlaState(false, null, deadline, new Date('2026-09-01T12:00:00Z'))).toBe('ON_TRACK');
  });

  it('returns BREACHED when past deadline and unresolved', () => {
    expect(evaluateSlaState(false, null, deadline, new Date('2026-09-02T01:00:00Z'))).toBe('BREACHED');
  });

  it('returns MET when resolved before deadline', () => {
    expect(evaluateSlaState(true, new Date('2026-09-01T23:00:00Z'), deadline)).toBe('MET');
  });

  it('returns BREACHED when resolved after deadline', () => {
    expect(evaluateSlaState(true, new Date('2026-09-02T01:00:00Z'), deadline)).toBe('BREACHED');
  });
});
