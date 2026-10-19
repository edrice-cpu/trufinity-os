import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import type { LaceExportFreshness } from './lace-freshness';

// Raises the alert SPEC-BI-001 Layer 1 requires when a Lace export is
// unhealthy (FAILING / STALE / NO_DATA): always an ERROR log, and an email to
// the alert recipient (see pipelineAlertRecipient) when SMTP is configured. The same
// export+status is emailed at most once per REALERT_AFTER_MS so a feed that
// stays broken doesn't send a message every check; a recovery clears it, so
// the next breakage alerts again straight away. Kept in memory (single API
// process); a restart can repeat one alert, which is acceptable.
export interface AlertMailer {
  send(subject: string, text: string): Promise<void>;
}

const REALERT_AFTER_MS = 24 * 60 * 60 * 1000;

// PIPELINE_ALERT_RECIPIENT when set; otherwise Lace feed alerts go to the
// company's own Lace inbox (LACE_REPORT_MAILBOX) - a shared company mailbox,
// never a personal address. The report-inbox reader only picks up messages
// matching LACE_REPORT_GMAIL_QUERY, so these alerts are never ingested.
export const pipelineAlertRecipient = (): string | undefined =>
  env.PIPELINE_ALERT_RECIPIENT ?? (env.LACE_REPORT_MAILBOX.trim() || undefined);

class SmtpAlertMailer implements AlertMailer {
  private transporter: Transporter | undefined;

  public async send(subject: string, text: string): Promise<void> {
    const recipient = pipelineAlertRecipient();
    if (!env.SMTP_HOST || !recipient) return;
    this.transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    });
    await this.transporter.sendMail({ from: env.MAIL_FROM, to: recipient, subject, text });
  }
}

const describe = (f: LaceExportFreshness): string => {
  switch (f.status) {
    case 'FAILING': return `the last ${f.consecutiveFailures} sync run(s) failed`;
    case 'STALE': return `no new Lace file for over ${f.maxFileAgeHours} hours (last file: ${f.lastFileIngestedAt ?? 'never'})`;
    case 'NO_DATA': return 'no Lace data has ever been ingested';
    default: return 'healthy';
  }
};

export class LacePipelineAlerter {
  private readonly lastAlerted = new Map<string, number>();

  public constructor(
    private readonly mailer: AlertMailer = new SmtpAlertMailer(),
    private readonly now: () => number = Date.now,
  ) {}

  public async check(freshness: LaceExportFreshness[]): Promise<LaceExportFreshness[]> {
    const unhealthy = freshness.filter((f) => f.status !== 'OK');
    for (const f of freshness) {
      if (f.status === 'OK') {
        for (const key of this.lastAlerted.keys()) if (key.startsWith(`${f.exportType}:`)) this.lastAlerted.delete(key);
      }
    }

    for (const f of unhealthy) {
      const reason = describe(f);
      logger.error(`[LaceAI] ${f.exportType} feed is ${f.status}: ${reason}`, {
        exportType: f.exportType, status: f.status, lastSuccessfulSyncAt: f.lastSuccessfulSyncAt, lastFileIngestedAt: f.lastFileIngestedAt,
      });

      const key = `${f.exportType}:${f.status}`;
      const previous = this.lastAlerted.get(key);
      if (previous !== undefined && this.now() - previous < REALERT_AFTER_MS) continue;
      this.lastAlerted.set(key, this.now());
      try {
        await this.mailer.send(
          `[TruFinity] Lace AI ${f.exportType.replace('_', ' ')} feed is ${f.status}`,
          [
            `The Lace AI ${f.exportType.replace('_', ' ')} feed needs attention: ${reason}.`,
            '',
            `Last successful sync: ${f.lastSuccessfulSyncAt ?? 'never'}`,
            `Last file received:   ${f.lastFileIngestedAt ?? 'never'}`,
            `Newest data:          ${f.latestDataAt ?? 'none'}`,
            '',
            'Until this is fixed, Lace-based alerts (D-01, D-06) are running on incomplete data.',
          ].join('\n'),
        );
      } catch (error) {
        logger.error('[LaceAI] Failed to send pipeline alert email', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return unhealthy;
  }
}

export const lacePipelineAlerter = new LacePipelineAlerter();
