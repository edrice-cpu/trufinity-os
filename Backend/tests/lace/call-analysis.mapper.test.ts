import { describe, expect, it } from '@jest/globals';
import { mapCallAnalysisRowToCanonical } from '../../src/modules/lace/canonical/call-analysis.mapper';
import type { LaceCallAnalysisRow } from '../../src/modules/lace/lace.types';

function baseRow(overrides: Partial<LaceCallAnalysisRow> = {}): LaceCallAnalysisRow {
  return {
    CRM: 'SERVICE_TITAN',
    CSR: 'Dana Whitfield',
    Tags: 'Appointment Set',
    Booked: 'Booked',
    Company: 'Northwind Plumbing',
    Campaign: 'Organic - (Google)',
    'Call link': 'https://www.lace.ai/app/call-center-all-calls/85a301f5dc6fbb39',
    Qualified: 'Qualified',
    'Job number': '64981289',
    Objections: 'Service Fee Concerns, Other, Customer Data Privacy Concerns',
    'CRM call id': '65046054',
    'CRM tenant id': '0000000000',
    'Customer name': 'Don Habijanac',
    'Short summary': 'Summary text',
    'Call direction': 'Inbound',
    'Customer phone': '4038187101',
    'Duration (sec)': '164',
    'Playbook score': '89%',
    'Unbooked reason': '',
    'Existing customer': 'yes',
    'Cancellation reason': '',
    'Date received (UTC)': '2026-02-18',
    'Time received (UTC)': '16:09:28',
    'Date received (Local)': '2026-02-18',
    'Qualification details': 'Qualification text',
    'Time received (Local)': '08:09:28',
    ...overrides,
  };
}

describe('mapCallAnalysisRowToCanonical', () => {
  it('type-coerces booleans, numbers, arrays and the combined UTC timestamp from raw strings', () => {
    const canonical = mapCallAnalysisRowToCanonical('85a301f5dc6fbb39', baseRow());

    expect(canonical).toMatchObject({
      laceCallId: '85a301f5dc6fbb39',
      booked: true,
      qualified: true,
      existingCustomer: true,
      durationSec: 164,
      playbookScore: 89,
      objections: ['Service Fee Concerns', 'Other', 'Customer Data Privacy Concerns'],
    });
    expect(canonical.receivedAt?.toISOString()).toBe('2026-02-18T16:09:28.000Z');
  });

  it('maps "Unbooked" / "Not qualified" to false, not null', () => {
    const canonical = mapCallAnalysisRowToCanonical('id-2', baseRow({ Booked: 'Unbooked', Qualified: 'Not qualified' }));

    expect(canonical.booked).toBe(false);
    expect(canonical.qualified).toBe(false);
  });

  it('maps blank optional fields to null rather than empty strings', () => {
    const canonical = mapCallAnalysisRowToCanonical(
      'id-3',
      baseRow({ Objections: '', 'Existing customer': '', 'Unbooked reason': '', 'Playbook score': '' }),
    );

    expect(canonical.objections).toBeNull();
    expect(canonical.existingCustomer).toBeNull();
    expect(canonical.unbookedReason).toBeNull();
    expect(canonical.playbookScore).toBeNull();
  });

  it('keeps the full raw row in sourceSpecificData for traceability', () => {
    const row = baseRow();
    const canonical = mapCallAnalysisRowToCanonical('id-4', row);

    expect(canonical.sourceSpecificData).toEqual(row);
  });
});
