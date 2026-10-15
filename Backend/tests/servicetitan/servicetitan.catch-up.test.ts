import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const runs: Record<string, jest.Mock<() => Promise<unknown>>> = {};
const entity = (name: string) => {
  runs[name] = jest.fn<() => Promise<unknown>>(async () => ({ syncRunId: `run-${name}`, recordsProcessed: 0 }));
  return runs[name];
};

jest.mock('../../src/modules/servicetitan/ingestion/customer.ingestion', () => ({ serviceTitanCustomerIngestionService: { run: () => runs.Customer!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/location.ingestion', () => ({ serviceTitanLocationIngestionService: { run: () => runs.Location!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/job.ingestion', () => ({ serviceTitanJobIngestionService: { run: () => runs.Job!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/appointment.ingestion', () => ({ serviceTitanAppointmentIngestionService: { run: () => runs.Appointment!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/lead.ingestion', () => ({ serviceTitanLeadIngestionService: { run: () => runs.Lead!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/booking.ingestion', () => ({ serviceTitanBookingIngestionService: { run: () => runs.Booking!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/invoice.ingestion', () => ({ serviceTitanInvoiceIngestionService: { run: () => runs.Invoice!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/payment.ingestion', () => ({ serviceTitanPaymentIngestionService: { run: () => runs.Payment!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/technician.ingestion', () => ({ serviceTitanTechnicianIngestionService: { run: () => runs.Technician!() } }));
jest.mock('../../src/modules/servicetitan/ingestion/business-unit.ingestion', () => ({ serviceTitanBusinessUnitIngestionService: { run: () => runs.BusinessUnit!() } }));
jest.mock('../../src/utils/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));

import { db } from '../../src/database';
import { runMissedServiceTitanSyncs } from '../../src/modules/servicetitan/servicetitan.scheduler';

const ENTITIES = ['Customer', 'Location', 'Job', 'Appointment', 'Lead', 'Booking', 'Invoice', 'Payment', 'Technician', 'BusinessUnit'];
// Sentinel completion time later than any real/other-test sync run, so it is
// always the "last successful sync" the catch-up sees.
const LAST_SUCCESS = new Date('2091-01-01T00:00:00.000Z');
const hoursAfter = (h: number) => new Date(LAST_SUCCESS.getTime() + h * 3_600_000);

describe('runMissedServiceTitanSyncs', () => {
  beforeAll(async () => {
    await db('sync_runs').insert(ENTITIES.map((entityType) => ({
      source_system: 'ServiceTitan', entity_type: entityType, status: 'COMPLETED',
      started_at: LAST_SUCCESS, completed_at: LAST_SUCCESS, records_processed: 0,
    })));
  });

  afterAll(async () => {
    await db('sync_runs').where({ source_system: 'ServiceTitan' }).andWhere('started_at', '>=', '2091-01-01').andWhere('started_at', '<', '2092-01-01').delete();
    await db.destroy();
  });

  beforeEach(() => {
    for (const name of ENTITIES) entity(name);
  });

  it('runs nothing when every entity synced recently', async () => {
    expect(await runMissedServiceTitanSyncs({ now: hoursAfter(10) })).toEqual([]);
  });

  it('catches up the daily entities after a missed day, but not weekly Business Units', async () => {
    const ran = await runMissedServiceTitanSyncs({ now: hoursAfter(30) });
    expect(ran).toEqual(ENTITIES.filter((e) => e !== 'BusinessUnit'));
    expect(runs.Job).toHaveBeenCalledTimes(1);
    expect(runs.BusinessUnit).not.toHaveBeenCalled();
  });

  it('includes Business Units once they are more than 8 days old', async () => {
    expect(await runMissedServiceTitanSyncs({ now: hoursAfter(24 * 9) })).toEqual(ENTITIES);
  });

  it('runs everything when forced', async () => {
    expect(await runMissedServiceTitanSyncs({ force: true, now: hoursAfter(1) })).toEqual(ENTITIES);
  });

  it('keeps going when one entity fails', async () => {
    runs.Location = jest.fn<() => Promise<unknown>>(async () => { throw new Error('ServiceTitan unavailable'); });
    const ran = await runMissedServiceTitanSyncs({ now: hoursAfter(30) });
    expect(ran).toContain('Job');
    expect(runs.Invoice).toHaveBeenCalledTimes(1);
  });
});
