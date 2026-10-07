import type { Knex } from 'knex';
import { db } from '../../../database';
import { logger } from '../../../utils/logger';
import type { LaceCallAnalysisRow } from '../lace.types';
import { mapCallAnalysisRowToCanonical } from './call-analysis.mapper';

interface RawCallAnalysisRow {
  source_id: string;
  payload: LaceCallAnalysisRow;
}

// Rows are upserted in batches rather than one query per row - at real
// production volume (11,000+ calls/month) a one-row-at-a-time loop is
// thousands of sequential DB round-trips for no benefit, since the whole
// batch is already an independent upsert per lace_call_id.
const BATCH_SIZE = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

// Populates canonical_lace_calls from raw_lace_call_analysis (is_latest rows only).
// Upserts on lace_call_id so re-running after a corrected re-export (which flips
// is_latest on the raw table) keeps the canonical row in sync rather than duplicating it.
export class CallAnalysisCanonicalService {
  public constructor(private readonly database: Knex = db) {}

  public async sync(): Promise<{ rowsUpserted: number }> {
    const rows: RawCallAnalysisRow[] = await this.database('raw_lace_call_analysis')
      .where({ is_latest: true })
      .select('source_id', 'payload');

    const canonicalRows = rows.map((row) => {
      const canonical = mapCallAnalysisRowToCanonical(row.source_id, row.payload);
      return {
        lace_call_id: canonical.laceCallId,
        crm: canonical.crm,
        csr: canonical.csr,
        company: canonical.company,
        campaign: canonical.campaign,
        call_link: canonical.callLink,
        job_number: canonical.jobNumber,
        crm_call_id: canonical.crmCallId,
        crm_tenant_id: canonical.crmTenantId,
        customer_name: canonical.customerName,
        customer_phone: canonical.customerPhone,
        call_direction: canonical.callDirection,
        booked: canonical.booked,
        qualified: canonical.qualified,
        existing_customer: canonical.existingCustomer,
        duration_sec: canonical.durationSec,
        playbook_score: canonical.playbookScore,
        objections: canonical.objections,
        unbooked_reason: canonical.unbookedReason,
        cancellation_reason: canonical.cancellationReason,
        short_summary: canonical.shortSummary,
        qualification_details: canonical.qualificationDetails,
        received_at: canonical.receivedAt,
        source_specific_data: canonical.sourceSpecificData,
        updated_at: this.database.fn.now(),
      };
    });

    for (const batch of chunk(canonicalRows, BATCH_SIZE)) {
      await this.database('canonical_lace_calls').insert(batch).onConflict('lace_call_id').merge();
    }

    const rowsUpserted = canonicalRows.length;
    logger.info('[LaceAI] Canonical call analysis sync completed', { rowsUpserted });
    return { rowsUpserted };
  }
}

export const callAnalysisCanonicalService = new CallAnalysisCanonicalService();
