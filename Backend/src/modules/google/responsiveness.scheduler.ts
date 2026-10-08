/**
 * GoogleResponsivenessScheduler
 *
 * Periodic evaluation loop for Google Workspace responsiveness rules (R-01, and
 * eventually R-02–R-05). Follows the same polling/abort pattern as
 * GmailIncrementalScheduler.
 *
 * Design:
 * - Single concurrent cycle: if the previous cycle hasn't finished when the
 *   next interval fires, the new tick is skipped and logged.
 * - Graceful stop: AbortController signals the wait; the loop drains the
 *   current cycle before exiting.
 * - Failure isolation: an exception in one cycle is caught and logged; the
 *   scheduler continues on the next interval.
 */

import { performance } from 'node:perf_hooks';

export interface ResponsivenessSchedulerLogger {
  info(message: string): unknown;
  warn(message: string): unknown;
  error(message: string): unknown;
}

export interface ResponsivenessSchedulerOptions {
  runEvaluation(): Promise<{ alertsOpened: number; alertsClosed: number }>;
  logger: ResponsivenessSchedulerLogger;
  intervalMs: number;
  /** Injectable for tests. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface ResponsivenessEvalSummary {
  alertsOpened: number;
  alertsClosed: number;
  durationMs: number;
}

const abortableWait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });

export class GoogleResponsivenessScheduler {
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private cyclePromise: Promise<ResponsivenessEvalSummary> | undefined;
  private readonly controller = new AbortController();
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  public constructor(private readonly options: ResponsivenessSchedulerOptions) {
    if (options.intervalMs < 300_000 || options.intervalMs > 86_400_000) {
      throw new Error('Responsiveness scheduler interval must be between 300000 and 86400000 ms.');
    }
    this.wait = options.wait ?? abortableWait;
    this.now = options.now ?? (() => performance.now());
  }

  public runCycle(): Promise<ResponsivenessEvalSummary> {
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
    void this.loopPromise.catch(() => {
      this.options.logger.error('Google Workspace responsiveness scheduler loop stopped unexpectedly.');
    });
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

  private async executeCycle(): Promise<ResponsivenessEvalSummary> {
    const startedAt = this.now();
    let alertsOpened = 0;
    let alertsClosed = 0;
    try {
      const result = await this.options.runEvaluation();
      alertsOpened = result.alertsOpened;
      alertsClosed = result.alertsClosed;
    } catch (err) {
      this.options.logger.error(
        `Google Workspace responsiveness cycle encountered an unhandled exception: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const durationMs = Math.max(0, Math.round(this.now() - startedAt));
    this.options.logger.info(
      `Google Workspace responsiveness cycle complete; alertsOpened=${alertsOpened}; alertsClosed=${alertsClosed}; durationMs=${durationMs}.`,
    );
    return { alertsOpened, alertsClosed, durationMs };
  }
}
