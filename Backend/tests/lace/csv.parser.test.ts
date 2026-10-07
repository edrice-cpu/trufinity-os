import { describe, expect, it } from '@jest/globals';
import { parseLaceCsv } from '../../src/modules/lace/csv.parser';

const CALL_ANALYSIS_SAMPLE = `Lace call id,CRM call id,CRM call secondary id,Tenant,Company,Call start (tenant time),Call start (UTC),Timezone,Direction,Customer phone,Customer name,Agent name,Duration (sec),Source,Disposition,Qualified,Non-qualified reason,Booked,Playbook score,Tags,Transfer reason,Recording URL,Call link,Cancellation reason,Short summary,Qualification details
90010001,ST-4471902,,Northwind Home Services (SAMPLE),Northwind Plumbing,2026-08-24 07:42:11,2026-08-24 12:42:11,America/New_York,Inbound,+1 555-0142,Alicia Brenner,Dana Whitfield,412,Google LSA,Booked,Yes,,Yes,92,Appointment Set;Membership Offered,,https://example.invalid/rec/90010001,https://www.lace.ai/admin/#/cc/call-info/90010001,,"Customer reported a leaking water heater, agent booked a visit.","Homeowner in service area, appointment accepted."
90010007,,,Northwind Home Services (SAMPLE),Northwind HVAC,2026-08-24 10:39:03,2026-08-24 15:39:03,America/New_York,Inbound,+1 555-0129,,,22,Google LSA,Abandoned,No,Abandoned before answer,No,,Abandoned,,,https://www.lace.ai/admin/#/cc/call-info/90010007,,"Caller hung up after 22 seconds in queue.","Not qualified - call abandoned before an agent answered."
`;

const AGENT_PERFORMANCE_SAMPLE = `Agent name,Agent id,Company,Period,Period start,Period end,Total calls,Analyzed calls,Qualified calls,Qualified %,Booked calls,Booking rate %,Target booking rate %,Variance vs target,Qualified & unbooked,Avg playbook score,Avg handle time (sec),Transferred calls,Transfer rate %,Jobs created,Jobs completed,Jobs cancelled,Invoice subtotal (USD),Revenue per booked call (USD)
Dana Whitfield,4412,Northwind Plumbing,MONTHLY,2026-07-01,2026-07-31,318,318,241,75.79,214,88.80,90.00,-1.20,27,89.40,371,18,5.66,214,197,17,284350.00,1328.74
TOTAL / TENANT,,Northwind Home Services,MONTHLY,2026-07-01,2026-07-31,2315,2315,1711,73.91,1482,86.62,90.00,-3.38,229,85.61,346,155,6.70,1482,1366,116,1875130.00,1265.27
`;

describe('parseLaceCsv', () => {
  it('parses Call Analysis Export rows keyed by the vendor column headers', () => {
    const rows = parseLaceCsv(CALL_ANALYSIS_SAMPLE);

    expect(rows).toHaveLength(2);
    expect(rows[0]['Lace call id']).toBe('90010001');
    expect(rows[0]['CRM call id']).toBe('ST-4471902');
    expect(rows[0]['Short summary']).toBe('Customer reported a leaking water heater, agent booked a visit.');
  });

  it('keeps blank fields as empty strings rather than dropping them (e.g. an abandoned call with no agent)', () => {
    const rows = parseLaceCsv(CALL_ANALYSIS_SAMPLE);
    const abandoned = rows[1];

    expect(abandoned['Lace call id']).toBe('90010007');
    expect(abandoned['CRM call id']).toBe('');
    expect(abandoned['Agent name']).toBe('');
    expect(abandoned.Disposition).toBe('Abandoned');
  });

  it('parses Agent Performance rows, including the blank-id tenant rollup row', () => {
    const rows = parseLaceCsv(AGENT_PERFORMANCE_SAMPLE);

    expect(rows).toHaveLength(2);
    expect(rows[0]['Agent id']).toBe('4412');
    expect(rows[1]['Agent id']).toBe('');
    expect(rows[1]['Agent name']).toBe('TOTAL / TENANT');
  });

  it('returns an empty array for empty input', () => {
    expect(parseLaceCsv('')).toEqual([]);
  });

  it('returns an empty array for header-only input (no data rows)', () => {
    expect(parseLaceCsv('a,b,c\n')).toEqual([]);
  });

  it('unescapes a quoted field containing a comma instead of splitting it into extra columns', () => {
    const rows = parseLaceCsv('Short summary,Booked\n"Customer said, quote, unquote","Booked"\n');
    expect(rows).toEqual([{ 'Short summary': 'Customer said, quote, unquote', Booked: 'Booked' }]);
  });

  it('unescapes a quoted field containing an embedded newline', () => {
    const rows = parseLaceCsv('Short summary,Booked\n"Line one\nLine two","Booked"\n');
    expect(rows[0]['Short summary']).toBe('Line one\nLine two');
  });

  it('tolerates a row with fewer columns than the header (relax_column_count) instead of throwing', () => {
    const rows = parseLaceCsv('a,b,c\n1,2\n');
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('tolerates a row with more columns than the header (relax_column_count) instead of throwing', () => {
    const rows = parseLaceCsv('a,b,c\n1,2,3,4\n');
    expect(rows).toEqual([{ a: '1', b: '2', c: '3' }]);
  });
});
