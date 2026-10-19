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
const telecomRun = jest.fn<() => Promise<unknown>>();
const v3Run = jest.fn<() => Promise<unknown>>();
const loggerInfo = jest.fn();
const loggerError = jest.fn();
const loggerWarn = jest.fn();
const scheduledTasks: string[] = [];
const dbFirst = jest.fn<() => Promise<unknown>>();

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
jest.mock('../../src/modules/servicetitan/ingestion/telecom-calls.ingestion', () => ({
  serviceTitanTelecomCallsIngestionService: { run: telecomRun },
  TelecomCallsSyncInProgressError: class TelecomCallsSyncInProgressError extends Error {
    constructor(msg?: string) { super(msg); this.name = 'TelecomCallsSyncInProgressError'; }
  },
}));
jest.mock('../../src/modules/servicetitan/ingestion/telecom-calls-v3.ingestion', () => ({
  serviceTitanTelecomCallsV3IngestionService: { run: v3Run },
  V3SyncInProgressError: class V3SyncInProgressError extends Error {
    constructor(msg?: string) { super(msg); this.name = 'V3SyncInProgressError'; }
  },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: loggerInfo, error: loggerError, warn: loggerWarn, debug: jest.fn() },
}));
jest.mock('node-cron', () => ({
  schedule: (expression: string, handler: () => void) => {
    scheduledTasks.push(expression);
    return { handler };
  },
}));
jest.mock('../../src/database', () => ({
  db: Object.assign(
    jest.fn(() => ({ where: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), first: dbFirst, orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(), returning: jest.fn().mockResolvedValue([] as never) })),
    { fn: { now: jest.fn() } },
  ),
}));

// Helpers that import the scheduler under controlled env overrides.
// jest.resetModules() is called before each test so each import sees a fresh module.
async function importScheduler(telecomEnabled = false, v3Enabled = false) {
  const prevTelecom = process.env.SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED;
  const prevV3 = process.env.SERVICETITAN_TELECOM_V3_SYNC_ENABLED;
  process.env.SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED = telecomEnabled ? 'true' : 'false';
  process.env.SERVICETITAN_TELECOM_V3_SYNC_ENABLED = v3Enabled ? 'true' : 'false';
  try {
    const { startServiceTitanScheduler } = await import('../../src/modules/servicetitan/servicetitan.scheduler');
    const { env } = await import('../../src/config/env');
    return { startServiceTitanScheduler, env };
  } finally {
    if (prevTelecom === undefined) delete process.env.SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED;
    else process.env.SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED = prevTelecom;
    if (prevV3 === undefined) delete process.env.SERVICETITAN_TELECOM_V3_SYNC_ENABLED;
    else process.env.SERVICETITAN_TELECOM_V3_SYNC_ENABLED = prevV3;
  }
}

describe('ServiceTitan scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    scheduledTasks.length = 0;
    dbFirst.mockResolvedValue({ last_synced_at: new Date() });
  });

  // --- Feature flag: disabled (default) ---

  it('registers 11 cron tasks when Telecom sync is disabled (default): 9 regular entities + BusinessUnit + reaper', async () => {
    const { startServiceTitanScheduler, env } = await importScheduler(false);

    startServiceTitanScheduler();

    expect(scheduledTasks).toEqual([
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON,
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON,
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_BUSINESS_UNIT_SYNC_CRON,
      env.SERVICETITAN_STUCK_RUN_REAPER_CRON,
    ]);
    expect(scheduledTasks).toHaveLength(11);
  });

  it('logs that Telecom scheduling is disabled when the flag is false', async () => {
    const { startServiceTitanScheduler } = await importScheduler(false);

    startServiceTitanScheduler();

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('TelecomCall incremental sync is disabled'));
  });

  it('does not register a Telecom cron task when the flag is false', async () => {
    const { startServiceTitanScheduler, env } = await importScheduler(false);

    startServiceTitanScheduler();

    expect(scheduledTasks).not.toContain(env.SERVICETITAN_TELECOM_CALLS_SYNC_CRON);
  });

  // --- Feature flag: enabled ---

  it('registers 12 cron tasks when Telecom sync is enabled: 9 regular + BusinessUnit + TelecomCall + reaper', async () => {
    const { startServiceTitanScheduler, env } = await importScheduler(true);

    startServiceTitanScheduler();

    expect(scheduledTasks).toEqual([
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON,
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_SYNC_CRON,
      env.SERVICETITAN_SYNC_CRON, env.SERVICETITAN_BUSINESS_UNIT_SYNC_CRON,
      env.SERVICETITAN_TELECOM_CALLS_SYNC_CRON, env.SERVICETITAN_STUCK_RUN_REAPER_CRON,
    ]);
    expect(scheduledTasks).toHaveLength(12);
  });

  it('logs that Telecom scheduling is enabled when the flag is true', async () => {
    const { startServiceTitanScheduler, env } = await importScheduler(true);

    startServiceTitanScheduler();

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('Scheduled TelecomCall incremental sync'),
      // No second argument — purely a string log
    );
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining(env.SERVICETITAN_TELECOM_CALLS_SYNC_CRON));
  });

  // --- Existing entity sync behaviour (unchanged) ---

  it('running a scheduled tick calls the matching ingestion service', async () => {
    customerRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5 });
    const { startServiceTitanScheduler } = await importScheduler(false);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[0].handler();

    expect(customerRun).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('Customer sync completed'), expect.anything());
  });

  it('logs a sync failure loudly', async () => {
    locationRun.mockRejectedValue(new Error('export boom'));
    const { startServiceTitanScheduler } = await importScheduler(false);

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
    const { startServiceTitanScheduler } = await importScheduler(false);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[2].handler()).resolves.toBeUndefined();

    expect(jobRun).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('skipped: already running'));
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('runs Business Units on its own (separately configured) schedule', async () => {
    businessUnitRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 3 });
    const { startServiceTitanScheduler } = await importScheduler(false);

    // task index 9 = BusinessUnit (0–8 are regular entities)
    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[9].handler();

    expect(businessUnitRun).toHaveBeenCalledTimes(1);
  });

  // --- Telecom-specific behaviour (only when enabled) ---

  it('TelecomCall sync completes and logs success', async () => {
    telecomRun.mockResolvedValue({ syncRunId: 'tc-run-1', recordsProcessed: 42 });
    const { startServiceTitanScheduler } = await importScheduler(true);

    // task index 10 = TelecomCall (enabled path)
    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[10].handler();

    expect(telecomRun).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('TelecomCall sync completed'),
      expect.objectContaining({ recordsProcessed: 42 }),
    );
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('TelecomCall sync swallows TelecomCallsSyncInProgressError and logs at info level', async () => {
    const { TelecomCallsSyncInProgressError } = await import('../../src/modules/servicetitan/ingestion/telecom-calls.ingestion') as {
      TelecomCallsSyncInProgressError: new (msg?: string) => Error;
    };
    telecomRun.mockRejectedValue(new TelecomCallsSyncInProgressError('TelecomCall'));
    const { startServiceTitanScheduler } = await importScheduler(true);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[10].handler()).resolves.toBeUndefined();

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('TelecomCall sync skipped: already running'));
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('TelecomCall sync logs error and checks repeated failures on non-in-progress error', async () => {
    telecomRun.mockRejectedValue(new Error('telecom boom'));
    const { startServiceTitanScheduler } = await importScheduler(true);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[10].handler()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('TelecomCall sync failed'),
      expect.objectContaining({ error: 'telecom boom' }),
    );
  });

  it('TelecomCall sync warns when record count exceeds expected incremental volume', async () => {
    telecomRun.mockResolvedValue({ syncRunId: 'tc-run-2', recordsProcessed: 6000 });
    const { startServiceTitanScheduler } = await importScheduler(true);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[10].handler();

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('unexpectedly high record count'),
      expect.objectContaining({ recordsProcessed: 6000 }),
    );
  });

  it('TelecomCall sync warns when checkpoint is stale', async () => {
    telecomRun.mockResolvedValue({ syncRunId: 'tc-run-3', recordsProcessed: 10 });
    const staleDate = new Date(Date.now() - 8 * 60 * 60_000); // 8 hours ago
    dbFirst.mockResolvedValue({ last_synced_at: staleDate });
    const { startServiceTitanScheduler } = await importScheduler(true);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[10].handler();

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('checkpoint is stale'),
      expect.objectContaining({ staleThresholdHours: 6 }),
    );
  });

  it('TelecomCall sync warns when no checkpoint exists (historical ingestion not run)', async () => {
    telecomRun.mockResolvedValue({ syncRunId: 'tc-run-4', recordsProcessed: 0 });
    dbFirst.mockResolvedValue(undefined);
    const { startServiceTitanScheduler } = await importScheduler(true);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[10].handler();

    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('checkpoint missing'));
  });

  it('TelecomCall sync does not fire stale warning when checkpoint is fresh', async () => {
    telecomRun.mockResolvedValue({ syncRunId: 'tc-run-5', recordsProcessed: 0 });
    dbFirst.mockResolvedValue({ last_synced_at: new Date() }); // just now
    const { startServiceTitanScheduler } = await importScheduler(true);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[10].handler();

    expect(loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('checkpoint is stale'), expect.anything());
  });

  // ── V3 TelecomCall enrichment scheduler ─────────────────────────────────────

  it('does NOT register V3 task when SERVICETITAN_TELECOM_V3_SYNC_ENABLED=false (default)', async () => {
    const { startServiceTitanScheduler, env } = await importScheduler(false, false);

    startServiceTitanScheduler();

    expect(scheduledTasks).not.toContain(env.SERVICETITAN_TELECOM_V3_SYNC_CRON);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('TelecomCallV3 enrichment sync is disabled'));
  });

  it('registers V3 task when SERVICETITAN_TELECOM_V3_SYNC_ENABLED=true', async () => {
    const { startServiceTitanScheduler, env } = await importScheduler(false, true);

    startServiceTitanScheduler();

    expect(scheduledTasks).toContain(env.SERVICETITAN_TELECOM_V3_SYNC_CRON);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('Scheduled TelecomCallV3 enrichment sync'));
  });

  it('task count with both V2 telecom and V3 enabled is 13 (9 regular + BusinessUnit + TelecomCall + V3 + reaper)', async () => {
    const { startServiceTitanScheduler } = await importScheduler(true, true);

    startServiceTitanScheduler();

    expect(scheduledTasks).toHaveLength(13);
  });

  it('V3 scheduled tick calls v3Run and logs success', async () => {
    v3Run.mockResolvedValue({ syncRunId: 'v3-run-1', recordsProcessed: 17 });
    const { startServiceTitanScheduler } = await importScheduler(false, true);

    // V3 enabled, V2 telecom disabled → task layout: 10 regular tasks + V3 + reaper
    // V3 is at index 10, reaper at 11
    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[10].handler();

    expect(v3Run).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining('TelecomCallV3 enrichment sync completed'),
      expect.objectContaining({ recordsProcessed: 17 }),
    );
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('V3 scheduled tick swallows V3SyncInProgressError and logs at info level — prevents overlapping runs', async () => {
    const { V3SyncInProgressError } = await import('../../src/modules/servicetitan/ingestion/telecom-calls-v3.ingestion') as {
      V3SyncInProgressError: new (msg?: string) => Error;
    };
    v3Run.mockRejectedValue(new V3SyncInProgressError('already running'));
    const { startServiceTitanScheduler } = await importScheduler(false, true);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[10].handler()).resolves.toBeUndefined();

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('TelecomCallV3 enrichment sync skipped: already running'));
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('V3 scheduled tick logs error and checks repeated failures on non-lock error', async () => {
    v3Run.mockRejectedValue(new Error('v3 boom'));
    const { startServiceTitanScheduler } = await importScheduler(false, true);

    const tasks = startServiceTitanScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[10].handler()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('TelecomCallV3 enrichment sync failed'),
      expect.objectContaining({ error: 'v3 boom' }),
    );
  });

  it('V3 sync does not register when only V2 telecom is enabled (flags are independent)', async () => {
    const { startServiceTitanScheduler, env } = await importScheduler(true, false);

    startServiceTitanScheduler();

    // V2 telecom cron is present, V3 cron is not
    expect(scheduledTasks.filter(t => t === env.SERVICETITAN_TELECOM_CALLS_SYNC_CRON)).toHaveLength(1);
    expect(scheduledTasks).not.toContain(env.SERVICETITAN_TELECOM_V3_SYNC_CRON);
  });
});
