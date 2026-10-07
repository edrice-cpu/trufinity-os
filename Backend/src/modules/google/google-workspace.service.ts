import type { Knex } from 'knex';
import { db } from '../../database';

export type WorkItemSlaState = 'UNCONFIGURED' | 'ON_TRACK' | 'BREACHED' | 'MET';
export type WorkItemWorkflowStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'CLOSED';
export type WorkItemWorkType = 'ESCALATION' | 'REVIEW_REQUIRED';

export interface WorkItemRow {
  id: string;
  workType: WorkItemWorkType;
  workflowStatus: WorkItemWorkflowStatus;
  slaState: WorkItemSlaState;
  mailboxAddress: string;
  providerMessageId: string;
  // Gmail direct-message URL derived from providerMessageId — no API call.
  // Format: https://mail.google.com/mail/u/0/#all/{providerMessageId}
  // The `u/0` segment opens the first signed-in Google account; the frontend
  // should direct the user to sign in to the correct mailboxAddress first.
  sourceUrl: string;
  routedOwnerReference: string | null;
  resolutionDeadline: Date | null;
  acknowledgementDeadline: Date | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  // from classification JOIN
  classificationId: string;
  classificationLabel: string;
  confidence: number;
  reason: string;
  decisionStatus: string;
  classifiedAt: Date;
  // from raw_gmail_messages JOIN (nullable — message may not be synced)
  senderFrom: string | null;
}

export interface WorkItemListFilters {
  workType?: WorkItemWorkType;
  workflowStatus?: WorkItemWorkflowStatus;
  mailboxAddress?: string;
  slaState?: WorkItemSlaState;
  page?: number;
  pageSize?: number;
}

export interface WorkItemListResult {
  items: WorkItemRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface WorkItemStats {
  totalOpen: number;
  escalation: number;
  reviewRequired: number;
  acknowledged: number;
  resolved: number;
  breached: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Builds a deterministic Gmail deep-link from the persisted provider message ID.
// Uses Gmail's direct-message URL scheme (#all/{id}) — no API call, no unescaped
// user-controlled data in the path (hex IDs contain only [0-9a-f] characters).
const buildSourceUrl = (providerMessageId: string): string =>
  `https://mail.google.com/mail/u/0/#all/${providerMessageId}`;

const effectiveSlaState = (row: { sla_state: string; resolution_deadline: Date | null; workflow_status: string }): WorkItemSlaState => {
  const terminal = row.workflow_status === 'RESOLVED' || row.workflow_status === 'CLOSED';
  if (!terminal && row.resolution_deadline && row.resolution_deadline < new Date()) return 'BREACHED';
  const s = row.sla_state as WorkItemSlaState;
  // AT_RISK was removed in migration 015 but guard against stale data
  if (s === ('AT_RISK' as string)) return 'ON_TRACK';
  return s;
};

const extractFromHeader = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const headers = (payload as Record<string, unknown>).headers;
  if (!Array.isArray(headers)) return null;
  for (const h of headers) {
    if (typeof h !== 'object' || h === null) continue;
    const entry = h as Record<string, unknown>;
    if (typeof entry.name === 'string' && entry.name.toLowerCase() === 'from' && typeof entry.value === 'string') {
      return entry.value;
    }
  }
  return null;
};

const mapRow = (r: Record<string, unknown>): WorkItemRow => ({
  id: r.id as string,
  workType: r.work_type as WorkItemWorkType,
  workflowStatus: r.workflow_status as WorkItemWorkflowStatus,
  slaState: effectiveSlaState({ sla_state: r.sla_state as string, resolution_deadline: r.resolution_deadline as Date | null, workflow_status: r.workflow_status as string }),
  mailboxAddress: r.mailbox_address as string,
  providerMessageId: r.provider_message_id as string,
  sourceUrl: buildSourceUrl(r.provider_message_id as string),
  routedOwnerReference: (r.routed_owner_reference as string | null) ?? null,
  resolutionDeadline: r.resolution_deadline as Date | null,
  acknowledgementDeadline: r.acknowledgement_deadline as Date | null,
  acknowledgedAt: r.acknowledged_at as Date | null,
  resolvedAt: r.resolved_at as Date | null,
  resolutionNote: (r.resolution_note as string | null) ?? null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
  classificationId: r.classification_id as string,
  classificationLabel: r.classification_label as string,
  confidence: Number(r.confidence),
  reason: r.reason as string,
  decisionStatus: r.decision_status as string,
  classifiedAt: r.classified_at as Date,
  senderFrom: extractFromHeader(r.gmail_payload),
});

const baseQuery = (database: Knex) =>
  database('email_escalation_work_items as w')
    .join('email_classification_results as c', 'c.id', 'w.classification_result_id')
    // is_latest = true prevents duplicates when raw_gmail_messages has historical
    // versions for the same provider_message_id/mailbox_address pair.
    .leftJoin('raw_gmail_messages as g', (join) =>
      join
        .on('g.provider_message_id', '=', 'w.provider_message_id')
        .on('g.mailbox_address', '=', 'c.mailbox_address')
        .onVal('g.is_latest', '=', true),
    )
    .select(
      'w.id',
      'w.work_type',
      'w.workflow_status',
      'w.sla_state',
      'c.mailbox_address',
      'w.provider_message_id',
      'w.routed_owner_reference',
      'w.resolution_deadline',
      'w.acknowledgement_deadline',
      'w.acknowledged_at',
      'w.resolved_at',
      'w.resolution_note',
      'w.created_at',
      'w.updated_at',
      'c.id as classification_id',
      'c.classification_label',
      'c.confidence',
      'c.reason',
      'c.decision_status',
      'c.classified_at',
      'g.payload as gmail_payload',
    )
    // NONE must never surface
    .whereIn('c.decision_status', ['ESCALATION', 'REVIEW_REQUIRED']);

// Applies effective SLA filtering in SQL so pagination happens on the correct
// result set. All four states are expressed as WHERE conditions:
//
//   BREACHED     — deadline passed, not terminal (computed, not persisted)
//   ON_TRACK     — persisted ON_TRACK AND not effectively BREACHED
//   MET          — persisted MET (terminal, deadline was met)
//   UNCONFIGURED — persisted UNCONFIGURED (no deadline configured)
//
// `now` is a JS Date bound as a query parameter, evaluated once per request.
const applySlaFilter = (q: Knex.QueryBuilder, slaState: WorkItemSlaState, now: Date): void => {
  switch (slaState) {
    case 'BREACHED':
      q.whereNotIn('w.workflow_status', ['RESOLVED', 'CLOSED'])
        .whereNotNull('w.resolution_deadline')
        .where('w.resolution_deadline', '<', now);
      break;
    case 'ON_TRACK':
      // Persisted ON_TRACK but not effectively BREACHED yet.
      q.where('w.sla_state', 'ON_TRACK').where((q2) => {
        q2.whereIn('w.workflow_status', ['RESOLVED', 'CLOSED'])
          .orWhereNull('w.resolution_deadline')
          .orWhere('w.resolution_deadline', '>=', now);
      });
      break;
    case 'MET':
      q.where('w.sla_state', 'MET');
      break;
    case 'UNCONFIGURED':
      q.where('w.sla_state', 'UNCONFIGURED');
      break;
  }
};

export class GoogleWorkspaceService {
  public constructor(private readonly database: Knex = db) {}

  public async listWorkItems(filters: WorkItemListFilters = {}): Promise<WorkItemListResult> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
    const offset = (page - 1) * pageSize;
    // Single timestamp for the entire request so list and count use the same "now".
    const now = new Date();

    const applyFilters = (q: Knex.QueryBuilder): void => {
      if (filters.workType) q.where('w.work_type', filters.workType);
      if (filters.workflowStatus) q.where('w.workflow_status', filters.workflowStatus);
      if (filters.mailboxAddress) q.where('c.mailbox_address', filters.mailboxAddress);
      // All SLA states — including effective BREACHED — are now expressed in SQL
      // so filtering, counting, and pagination all operate on the correct set.
      if (filters.slaState) applySlaFilter(q, filters.slaState, now);
    };

    // Count query: same joins and filters as the list query, no LIMIT/OFFSET.
    const countBase = this.database('email_escalation_work_items as w')
      .join('email_classification_results as c', 'c.id', 'w.classification_result_id')
      .whereIn('c.decision_status', ['ESCALATION', 'REVIEW_REQUIRED'])
      .count<{ count: string }[]>('w.id as count');
    applyFilters(countBase);
    const [{ count }] = await countBase;
    const total = Number(count);

    const query = baseQuery(this.database);
    applyFilters(query);

    const rows = await query
      .orderBy('c.classified_at', 'desc')
      .orderBy('w.id', 'asc')
      .limit(pageSize)
      .offset(offset);

    const items = (rows as unknown as Record<string, unknown>[]).map(mapRow);

    return { items, total, page, pageSize };
  }

  public async getWorkItemById(id: string): Promise<WorkItemRow | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = await baseQuery(this.database).where('w.id', id).first() as unknown as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  public async getWorkItemStats(): Promise<WorkItemStats> {
    const now = new Date();

    const rows = await this.database('email_escalation_work_items as w')
      .join('email_classification_results as c', 'c.id', 'w.classification_result_id')
      .whereIn('c.decision_status', ['ESCALATION', 'REVIEW_REQUIRED'])
      .select(
        'w.work_type',
        'w.workflow_status',
        'w.sla_state',
        'w.resolution_deadline',
      ) as unknown as Array<{ work_type: string; workflow_status: string; sla_state: string; resolution_deadline: Date | null }>;

    let totalOpen = 0;
    let escalation = 0;
    let reviewRequired = 0;
    let acknowledged = 0;
    let resolved = 0;
    let breached = 0;

    for (const r of rows) {
      const isTerminal = r.workflow_status === 'RESOLVED' || r.workflow_status === 'CLOSED';
      const effectiveBreach = !isTerminal && r.resolution_deadline != null && r.resolution_deadline < now;

      if (r.workflow_status === 'OPEN' || r.workflow_status === 'ACKNOWLEDGED') {
        totalOpen += 1;
        if (r.work_type === 'ESCALATION') escalation += 1;
        else if (r.work_type === 'REVIEW_REQUIRED') reviewRequired += 1;
      }
      if (r.workflow_status === 'ACKNOWLEDGED') acknowledged += 1;
      if (r.workflow_status === 'RESOLVED') resolved += 1;
      if (effectiveBreach) breached += 1;
    }

    return { totalOpen, escalation, reviewRequired, acknowledged, resolved, breached };
  }

  public async acknowledgeWorkItem(id: string): Promise<WorkItemRow | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = await this.database('email_escalation_work_items').where({ id }).first() as unknown as { workflow_status: string } | undefined;
    if (!row) return null;

    // Idempotent: already acknowledged or further along — still return the item
    if (row.workflow_status !== 'OPEN') {
      return this.getWorkItemById(id);
    }

    await this.database('email_escalation_work_items')
      .where({ id })
      .update({ workflow_status: 'ACKNOWLEDGED', acknowledged_at: new Date(), updated_at: new Date() });

    return this.getWorkItemById(id);
  }

  public async resolveWorkItem(id: string, resolutionNote: string): Promise<WorkItemRow | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = await this.database('email_escalation_work_items').where({ id }).first() as unknown as {
      workflow_status: string;
      sla_state: string;
      resolution_deadline: Date | null;
    } | undefined;
    if (!row) return null;

    if (row.workflow_status === 'RESOLVED' || row.workflow_status === 'CLOSED') {
      return this.getWorkItemById(id);
    }

    const now = new Date();
    // Compute terminal SLA state atomically with the resolution update:
    //   No deadline (UNCONFIGURED) → stays UNCONFIGURED
    //   Resolved within deadline   → MET
    //   Resolved after deadline    → BREACHED (persisted; terminal form of effective BREACHED)
    const terminalSlaState =
      row.sla_state === 'UNCONFIGURED' || row.resolution_deadline == null
        ? 'UNCONFIGURED'
        : row.resolution_deadline >= now
          ? 'MET'
          : 'BREACHED';

    await this.database('email_escalation_work_items')
      .where({ id })
      .update({ workflow_status: 'RESOLVED', resolved_at: now, resolution_note: resolutionNote, sla_state: terminalSlaState, updated_at: now });

    return this.getWorkItemById(id);
  }
}

export const googleWorkspaceService = new GoogleWorkspaceService();
