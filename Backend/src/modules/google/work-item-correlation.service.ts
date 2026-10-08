import type { Knex } from 'knex';
import { db } from '../../database';

// Parses "Display Name <email@example.com>" or bare "email@example.com" → lowercase
// trimmed address. Returns null for malformed/empty values.
export const parseEmailAddress = (raw: string | null | undefined): string | null => {
  if (!raw || !raw.trim()) return null;
  const match = /<([^>]+)>/.exec(raw);
  const candidate = (match ? match[1] : raw).trim().toLowerCase();
  // Minimal RFC 5321 sanity check: must contain exactly one @, local and domain parts present
  const atCount = (candidate.match(/@/g) ?? []).length;
  if (atCount !== 1) return null;
  const [local, domain] = candidate.split('@');
  if (!local || !domain || domain.indexOf('.') === -1) return null;
  return candidate;
};

export interface WorkItemCorrelationService {
  correlateWorkItem(workItemId: string): Promise<void>;
}

export class NoopWorkItemCorrelationService implements WorkItemCorrelationService {
  public async correlateWorkItem(_workItemId: string): Promise<void> {
    // No-op: used when correlation is disabled or in test contexts that don't need it.
  }
}

interface WorkItemLookupRow {
  provider_message_id: string;
  unified_customer_id: string | null;
}

interface GmailMessageRow {
  payload: Record<string, unknown> | null;
}

interface CustomerRow {
  id: string;
  name: string | null;
}

const extractFromHeader = (payload: Record<string, unknown> | null): string | null => {
  if (!payload || !Array.isArray(payload.headers)) return null;
  for (const h of payload.headers as unknown[]) {
    if (typeof h !== 'object' || h === null || Array.isArray(h)) continue;
    const entry = h as Record<string, unknown>;
    if (typeof entry.name === 'string' && entry.name.toLowerCase() === 'from' && typeof entry.value === 'string') {
      return entry.value;
    }
  }
  return null;
};

export class KnexWorkItemCorrelationService implements WorkItemCorrelationService {
  public constructor(private readonly database: Knex = db) {}

  public async correlateWorkItem(workItemId: string): Promise<void> {
    // 1. Load the work item to get provider_message_id and check if already correlated.
    const workItem = await this.database('email_escalation_work_items')
      .select('provider_message_id', 'unified_customer_id')
      .where({ id: workItemId })
      .first() as WorkItemLookupRow | undefined;

    if (!workItem) return;
    // Idempotent: if already correlated, skip re-correlation (avoids overwriting a human override).
    if (workItem.unified_customer_id !== null) return;

    // 2. Look up the latest Gmail message to extract the From header.
    const gmailMessage = await this.database('raw_gmail_messages')
      .select('payload')
      .where({ provider_message_id: workItem.provider_message_id, is_latest: true })
      .first() as GmailMessageRow | undefined;

    const senderEmail = parseEmailAddress(extractFromHeader(gmailMessage?.payload ?? null));
    if (!senderEmail) return;

    // 3. Match against unified_customers via the QBO PrimaryEmailAddr JSONB path.
    //    Conservative: require exactly one match to avoid false-positive correlation.
    const matches = await this.database('unified_customers')
      .select('id', 'name')
      .whereRaw(
        `lower(source_specific_data->'quickbooks'->'PrimaryEmailAddr'->>'Address') = ?`,
        [senderEmail],
      )
      // JOIN identity_mappings to exclude DELETED customer records.
      .whereExists(
        this.database('identity_mappings')
          .select(this.database.raw('1'))
          .where('identity_mappings.source_system', 'QuickBooks')
          .where('identity_mappings.entity_type', 'Customer')
          .where('identity_mappings.status', 'ACTIVE')
          .whereRaw('identity_mappings.unified_entity_id = unified_customers.id'),
      )
      .limit(2) as CustomerRow[];

    // Zero or ambiguous matches → leave null. False positive is worse than no correlation.
    if (matches.length !== 1) return;

    const customer = matches[0]!;
    await this.database('email_escalation_work_items')
      .where({ id: workItemId })
      .update({
        unified_customer_id: customer.id,
        customer_display_name: customer.name ?? null,
        updated_at: new Date(),
      });
  }
}

export const workItemCorrelationService = new KnexWorkItemCorrelationService();
export const noopWorkItemCorrelationService = new NoopWorkItemCorrelationService();
