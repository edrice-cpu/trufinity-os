import { performance } from 'node:perf_hooks';

export const DEFAULT_GMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const MIN_GMAIL_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_GMAIL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const validateGmailSyncInterval = (value: number): number => {
  if (!Number.isInteger(value) || value < MIN_GMAIL_SYNC_INTERVAL_MS || value > MAX_GMAIL_SYNC_INTERVAL_MS) {
    throw new Error('Gmail sync polling interval must be an integer between 300000 and 86400000 milliseconds.');
  }
  return value;
};

export interface GmailIncrementalSchedulerLogger { info(message: string): unknown; warn(message: string): unknown; error(message: string): unknown; }
export interface GmailIncrementalSchedulerOptions {
  runMailboxes(): Promise<{ completed: { mailboxAddress: string }[]; failed: { mailboxAddress: string }[] }>;
  logger: GmailIncrementalSchedulerLogger;
  intervalMs: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}
export interface GmailIncrementalCycleSummary { attempted: number; succeeded: number; failed: number; durationMs: number; }

const abortableWait = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const finish = (): void => {
    clearTimeout(timer);
    signal.removeEventListener('abort', finish);
    resolve();
  };
  const timer = setTimeout(finish, milliseconds);
  signal.addEventListener('abort', finish, { once: true });
});

export class GmailIncrementalScheduler {
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private cyclePromise: Promise<GmailIncrementalCycleSummary> | undefined;
  private readonly controller = new AbortController();
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  public constructor(private readonly options: GmailIncrementalSchedulerOptions) {
    validateGmailSyncInterval(options.intervalMs);
    this.wait = options.wait ?? abortableWait;
    this.now = options.now ?? (() => performance.now());
  }

  public runCycle(): Promise<GmailIncrementalCycleSummary> {
    if (this.cyclePromise) return this.cyclePromise;
    const cycle = this.executeCycle();
    this.cyclePromise = cycle;
    const clear = (): void => { if (this.cyclePromise === cycle) this.cyclePromise = undefined; };
    void cycle.then(clear, clear);
    return cycle;
  }

  public start(): void {
    if (this.loopPromise || this.stopping) return;
    this.loopPromise = this.runLoop();
    void this.loopPromise.catch(() => { this.options.logger.error('Google Workspace Gmail incremental scheduler loop stopped unexpectedly.'); });
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    if (this.loopPromise) await this.loopPromise;
    else if (this.cyclePromise) await this.cyclePromise;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      await this.runCycle();
      if (this.stopping) break;
      await this.wait(this.options.intervalMs, this.controller.signal);
    }
  }

  private async executeCycle(): Promise<GmailIncrementalCycleSummary> {
    const startedAt = this.now();
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const result = await this.options.runMailboxes();
      attempted = result.completed.length + result.failed.length;
      succeeded = result.completed.length;
      failed = result.failed.length;
    } catch {
      this.options.logger.error('Google Workspace Gmail incremental cycle encountered an unhandled exception.');
      failed = 1;
    }

    const summary = { attempted, succeeded, failed, durationMs: Math.max(0, Math.round(this.now() - startedAt)) };
    this.options.logger.warn(`Google Workspace Gmail incremental cycle complete; attempted=${attempted}; succeeded=${succeeded}; failed=${failed}; durationMs=${summary.durationMs}.`);
    
    return summary;
  }
}
