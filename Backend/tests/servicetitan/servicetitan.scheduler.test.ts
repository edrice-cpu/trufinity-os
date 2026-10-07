import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const customerRun = jest.fn<() => Promise<unknown>>();
const locationRun = jest.fn<() => Promise<unknown>>();
const jobRun = jest.fn<() => Promise<unknown>>();
const appointmentRun = jest.fn<() => Promise<unknown>>();
const leadRun = jest.fn<() => Promise<unknown>>();
const bookingRun = jest.fn<() => Promise<unknown>>();
const invoiceRun = jest.fn<() => Promise<unknown>>();
const paymentRun = jest.fn<() => Promise<unknown>>();
const technicianRun = jest.fn<() => Promise<unknown>>();
const businessUnitRun = jest.fn<() => Promise<unknown>>();
const loggerInfo = jest.fn();
const loggerError = jest.fn();
const loggerWarn = jest.fn();
const scheduledTasks: string[] = [];

jest.mock('../../src/modules/servicetitan/ingestion/customer.ingestion', () => ({ serviceTitanCustomerIngestionService: { run: customerRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/location.ingestion', () => ({ serviceTitanLocationIngestionService: { run: locationRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/job.ingestion', () => ({ serviceTitanJobIngestionService: { run: jobRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/appointment.ingestion', () => ({ serviceTitanAppointmentIngestionService: { run: appointmentRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/lead.ingestion', () => ({ serviceTitanLeadIngestionService: { run: leadRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/booking.ingestion', () => ({ serviceTitanBookingIngestionService: { run: bookingRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/invoice.ingestion', () => ({ serviceTitanInvoiceIngestionService: { run: invoiceRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/payment.ingestion', () => ({ serviceTitanPaymentIngestionService: { run: paymentRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/technician.ingestion', () => ({ serviceTitanTechnicianIngestionService: { run: technicianRun } }));
jest.mock('../../src/modules/servicetitan/ingestion/business-unit.ingestion', () => ({ serviceTitanBusinessUnitIngestionService: { run: businessUnitRun } }));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: loggerInfo, error: loggerError, warn: loggerWarn, debug: jest.fn() },
}));
jest.mock('node-cron', () => ({
  schedule: (expression: string, handler: () => void) => {
    scheduledTasks.push(expression);
    return { handler };
  },
}));

// Each test dynamically imports the scheduler fresh (resetModules), mirroring
// tests/lace/lace.scheduler.test.ts - the module-level SCHEDULED_SYNCS array
// shouldn't leak state between tests.
describe('ServiceTitan scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    scheduledTasks.length = 0;
  });

  it('registers a cron task for all 9 regular entities plus Business Units and the stuck-run reaper', async () => {
    const { startServiceTitanScheduler } = await import('../../src/modules/servicetitan/servicetitan.scheduler');
    const { env } = await import('../../src/config/env');

    startServiceTitanScheduler();

    expect(scheduledTasks).toEqual([
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON,
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON,
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_BUSINESS_UNIT_SYNC_CRON, env.SERVICETITAN_STUCK_RUN_REAPER_CRON,
    ]);
  });

  it('running a scheduled tick calls the matching ingestion service', async () => {
    customerRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5 });
    const { startServiceTitanScheduler } = await import('../../src/modules/servicetitan/servicetitan.scheduler');

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[0].handler();

    expect(customerRun).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('Customer sync completed'), expect.anything());
  });

  it('logs a sync failure loudly', async () => {
    locationRun.mockRejectedValue(new Error('export boom'));
    const { startServiceTitanScheduler } = await import('../../src/modules/servicetitan/servicetitan.scheduler');

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[1].handler()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Location sync failed'),
      expect.objectContaining({ error: 'export boom' }),
    );
  });

  it('swallows a SyncInProgressError from an overlapping run instead of crashing, and logs it at info level', async () => {
    const { SyncInProgressError } = await import('../../src/modules/servicetitan/ingestion/raw-export.ingestion');
    jobRun.mockRejectedValue(new SyncInProgressError('Job'));
    const { startServiceTitanScheduler } = await import('../../src/modules/servicetitan/servicetitan.scheduler');

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[2].handler()).resolves.toBeUndefined();

    expect(jobRun).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('skipped: already running'));
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('runs Business Units on its own (separately configured) schedule', async () => {
    businessUnitRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 3 });
    const { startServiceTitanScheduler } = await import('../../src/modules/servicetitan/servicetitan.scheduler');

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[9].handler();

    expect(businessUnitRun).toHaveBeenCalledTimes(1);
  });
});
