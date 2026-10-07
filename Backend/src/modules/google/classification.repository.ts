import type { Knex } from 'knex';
import { db } from '../../database';
import type { EmailClassification, EmailDecisionState } from './email-classifier';

export interface ClassificationPersistenceInput {
  mailboxId?: string | null;
  mailboxAddress: string;
  providerMessageId: string;
  threadId?: string | null;
  sourceReference?: string | null;
  classification: EmailClassification;
  decisionStatus: EmailDecisionState;
  modelProvider: string;
  modelName: string;
  promptVersion: string;
  classifiedAt?: Date;
  idempotencyKey: string;
  supersedesId?: string | null;
}

export interface PersistedClassification { id: string; workItemId: string | null; duplicate: boolean; }
export interface ClassificationIdentity { mailboxAddress: string; providerMessageId: string; modelProvider: string; modelName: string; promptVersion: string; }
export type ClassificationPersistenceStage = 'classification_persistence' | 'work_item_persistence';

export class ClassificationPersistenceError extends Error {
  constructor(public readonly stage: ClassificationPersistenceStage, public readonly cause: unknown) {
    super('Classification persistence failed.');
    this.name = 'ClassificationPersistenceError';
  }
}

const ESCALATION_SLA_HOURS = 12;
const REVIEW_REQUIRED_SLA_HOURS = 24;

export function computeResolutionDeadline(workType: 'ESCALATION' | 'REVIEW_REQUIRED', createdAt: Date): Date {
  const hours = workType === 'ESCALATION' ? ESCALATION_SLA_HOURS : REVIEW_REQUIRED_SLA_HOURS;
  return new Date(createdAt.getTime() + hours * 60 * 60 * 1000);
}

export type SlaState = 'UNCONFIGURED' | 'ON_TRACK' | 'BREACHED' | 'MET';

export function evaluateSlaState(resolved: boolean, resolvedAt: Date | null, resolutionDeadline: Date | null, now: Date = new Date()): SlaState {
  if (!resolutionDeadline) return 'UNCONFIGURED';
  if (resolved && resolvedAt) return resolvedAt <= resolutionDeadline ? 'MET' : 'BREACHED';
  return now > resolutionDeadline ? 'BREACHED' : 'ON_TRACK';
}

export interface EmailClassificationRepository {
  hasClassification(identity: ClassificationIdentity): Promise<boolean>;
  persist(input: ClassificationPersistenceInput): Promise<PersistedClassification>;
  persistInTransaction(trx: Knex.Transaction, input: ClassificationPersistenceInput): Promise<PersistedClassification>;
}
interface ClassificationRow { id: string; }

export class KnexEmailClassificationRepository implements EmailClassificationRepository {
  public constructor(private readonly database: Knex = db) {}

  public async hasClassification(identity: ClassificationIdentity): Promise<boolean> {
    const row: unknown = await this.database('email_classification_results').select('id').where({
      mailbox_address: identity.mailboxAddress,
      provider_message_id: identity.providerMessageId,
      model_provider: identity.modelProvider,
      model_name: identity.modelName,
      prompt_version: identity.promptVersion,
    }).first();
    return row !== undefined;
  }

  public async persist(input: ClassificationPersistenceInput): Promise<PersistedClassification> {
    return this.database.transaction((trx) => this.persistInTransaction(trx, input));
  }

  public async persistInTransaction(trx: Knex.Transaction, input: ClassificationPersistenceInput): Promise<PersistedClassification> {
    let row: ClassificationRow;
    let duplicate: boolean;
    try {
      const inserted = await trx('email_classification_results').insert({
        mailbox_id: input.mailboxId ?? null,
        mailbox_address: input.mailboxAddress,
        provider_message_id: input.providerMessageId,
        thread_id: input.threadId ?? null,
        source_reference: input.sourceReference ?? null,
        classification_label: input.classification.label,
        confidence: input.classification.confidence,
        reason: input.classification.reason,
        decision_status: input.decisionStatus,
        model_provider: input.modelProvider,
        model_name: input.modelName,
        prompt_version: input.promptVersion,
        classified_at: input.classifiedAt ?? new Date(),
        idempotency_key: input.idempotencyKey,
        supersedes_id: input.supersedesId ?? null,
      }).onConflict('idempotency_key').ignore().returning('id') as unknown as ClassificationRow[];
      duplicate = inserted.length === 0;
      const existing: unknown = await trx('email_classification_results').select('id').where({ idempotency_key: input.idempotencyKey }).first();
      const resolvedRow = inserted[0] ?? (existing as ClassificationRow | undefined);
      if (!resolvedRow?.id) throw new Error('Classification result persistence did not return an id.');
      row = resolvedRow;
    } catch (error) {
      throw new ClassificationPersistenceError('classification_persistence', error);
    }

    let workItemId: string | null = null;
    if (!duplicate && input.decisionStatus !== 'NONE') {
      try {
        const now = new Date();
        const workType = input.decisionStatus as 'ESCALATION' | 'REVIEW_REQUIRED';
        const resolutionDeadline = computeResolutionDeadline(workType, now);
        const workRows = await trx('email_escalation_work_items').insert({
          classification_result_id: row.id,
          mailbox_id: input.mailboxId ?? null,
          provider_message_id: input.providerMessageId,
          work_type: workType,
          resolution_deadline: resolutionDeadline,
          sla_state: 'ON_TRACK',
        }).onConflict('classification_result_id').ignore().returning('id') as unknown as ClassificationRow[];
        const existingWork: unknown = await trx('email_escalation_work_items').select('id').where({ classification_result_id: row.id }).first();
        workItemId = workRows[0]?.id ?? (existingWork as ClassificationRow | undefined)?.id ?? null;
      } catch (error) {
        throw new ClassificationPersistenceError('work_item_persistence', error);
      }
    }
    return { id: row.id, workItemId, duplicate };
  }
}
