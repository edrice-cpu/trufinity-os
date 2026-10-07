import { performance } from 'node:perf_hooks';
import { QBO_CDC_ENTITIES, type QboCdcEntity } from '../types';

export const DEFAULT_QBO_CDC_POLL_INTERVAL_MS = 15 * 60 * 1000;
export const MIN_QBO_CDC_POLL_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_QBO_CDC_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const validateQboCdcPollInterval = (value: number): number => {
  if (!Number.isInteger(value) || value < MIN_QBO_CDC_POLL_INTERVAL_MS || value > MAX_QBO_CDC_POLL_INTERVAL_MS) {
    throw new Error('QuickBooks CDC polling interval must be an integer between 300000 and 86400000 milliseconds.');
  }
  return value;
};

export interface QboCdcSchedulerLogger { info(message: string): unknown; warn(message: string): unknown; error(message: string): unknown; }
export interface QboCdcSchedulerOptions {
  runEntity(entity: QboCdcEntity): Promise<unknown>;
  afterSuccessfulCycle?: (() => Promise<void>) | undefined;
  logger: QboCdcSchedulerLogger;
  intervalMs: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}
export interface QboCdcCycleSummary { attempted: QboCdcEntity[]; succeeded: QboCdcEntity[]; failed: QboCdcEntity[]; durationMs: number; }

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

export class QboCdcScheduler {
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private cyclePromise: Promise<QboCdcCycleSummary> | undefined;
  private readonly controller = new AbortController();
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  public constructor(private readonly options: QboCdcSchedulerOptions) {
    validateQboCdcPollInterval(options.intervalMs);
    this.wait = options.wait ?? abortableWait;
    this.now = options.now ?? (() => performance.now());
  }

  public runCycle(): Promise<QboCdcCycleSummary> {
    if (this.cyclePromise) return this.cyclePromise;
    const cycle = this.executeCycle();
    this.cyclePromise = cycle;
    const clear = (): void => { if (this.cyclePromise === cycle) this.cyclePromise = undefined; };
    void cycle.then(clear, clear);
    return cycle;
  }

  /** Starts immediately; after each completed cycle, wait a full interval, including after overruns. */
  public start(): void {
    if (this.loopPromise || this.stopping) return;
    this.loopPromise = this.runLoop();
    void this.loopPromise.catch(() => { this.options.logger.error('QuickBooks CDC scheduler loop stopped unexpectedly.'); });
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

  private async executeCycle(): Promise<QboCdcCycleSummary> {
    const startedAt = this.now();
    const attempted: QboCdcEntity[] = [];
    const succeeded: QboCdcEntity[] = [];
    const failed: QboCdcEntity[] = [];
    for (const entity of QBO_CDC_ENTITIES) {
      attempted.push(entity);
      try { await this.options.runEntity(entity); succeeded.push(entity); }
      catch {
        failed.push(entity);
        this.options.logger.error(`QuickBooks CDC entity failed; entity=${entity}.`);
      }
    }
    const summary = { attempted, succeeded, failed, durationMs: Math.max(0, Math.round(this.now() - startedAt)) };
    this.options.logger.warn(`QuickBooks CDC cycle complete; attempted=${attempted.length}; succeeded=${succeeded.length}; failed=${failed.length}; durationMs=${summary.durationMs}.`);
    if (failed.length === 0 && this.options.afterSuccessfulCycle) {
      try {
        await this.options.afterSuccessfulCycle();
      } catch {
        this.options.logger.error('QuickBooks CDC post-cycle propagation failed; CDC results remain committed.');
      }
    }
    return summary;
  }
}
