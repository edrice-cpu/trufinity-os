import type { Knex } from 'knex';

// The ONE definition of booking rate in this system, matching Lace AI's own
// "Success Ratio": booked calls / qualified calls (SPEC-BI-001 4.1 - Lace owns
// booking rate; "two booking-rate numbers in one company is worse than none").
// Verified against Lace's Monthly Agent Performance Report: Success Ratio =
// Booked / Qualified for every CSR row (e.g. 45/56 = 80%, 279/313 = 89%), and
// our call-level Lace classifications reproduce it (Chilina, Oct: 61/69 = 88.4%
// vs 89% in Aug/Sep). Dividing by ALL calls instead gives ~19% for the same
// CSR - a completely different number. Only Lace's own per-call `qualified`
// and `booked` flags are counted; no call is reclassified here.
// booking-rate-reconciliation.ts checks this against Lace's reported figure.
export interface LaceBookingCounts {
  totalCalls: number;
  qualified: number;
  booked: number;
}

export function laceBookingRate(counts: LaceBookingCounts | undefined): number | null {
  return counts && counts.qualified > 0 ? counts.booked / counts.qualified : null;
}

const COUNT_COLUMNS = (database: Knex) => [
  database.raw('count(*) as total_calls'),
  // A call whose outcome Lace hasn't classified yet (booked IS NULL) is left
  // out of both sides rather than counted as a qualified non-booking.
  database.raw('count(*) filter (where qualified = true and booked is not null) as qualified'),
  // Booked among qualified calls, so the rate can never exceed 100%.
  database.raw('count(*) filter (where qualified = true and booked = true) as booked'),
];

interface CountRow { total_calls: string; qualified: string; booked: string }

const toCounts = (row: CountRow): LaceBookingCounts => ({
  totalCalls: Number(row.total_calls),
  qualified: Number(row.qualified),
  booked: Number(row.booked),
});

export async function laceBookingCounts(database: Knex, start: Date, end: Date): Promise<LaceBookingCounts> {
  const row = (await database('canonical_lace_calls')
    .where('received_at', '>=', start)
    .andWhere('received_at', '<', end)
    .select(COUNT_COLUMNS(database))
    .first()) as CountRow;
  return toCounts(row);
}

export async function laceBookingCountsByCsr(database: Knex, start: Date, end: Date): Promise<Map<string, LaceBookingCounts>> {
  const rows: (CountRow & { csr: string })[] = await database('canonical_lace_calls')
    .whereNotNull('csr')
    .andWhere('received_at', '>=', start)
    .andWhere('received_at', '<', end)
    .groupBy('csr')
    .select('csr', ...COUNT_COLUMNS(database));
  return new Map(rows.map((row) => [row.csr, toCounts(row)]));
}
