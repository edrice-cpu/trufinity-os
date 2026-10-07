import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';
import type { Knex } from 'knex';
import { db } from '../../database';

export interface WorkItemNotificationInput {
  workItemId: string;
  classificationId: string;
  workType: 'ESCALATION' | 'REVIEW_REQUIRED';
  classificationLabel: string;
  confidence: number;
  mailboxAddress: string;
  providerMessageId: string;
  sourceReference: string | null;
  classifiedAt: Date;
  resolutionDeadline: Date;
  // Transient context — in-memory during Layer B processing only, never persisted.
  senderEmail: string | null;
  senderName: string | null;
  subject: string | null;
  internalDate: Date | null;
  classifierReason: string | null;
  rfc822MessageId: string | null;
}

export interface WorkItemNotifier {
  sendNotification(input: WorkItemNotificationInput): Promise<boolean>;
  hasNotificationBeenSent(workItemId: string): Promise<boolean>;
  recoverPendingNotifications?(): Promise<number>;
}

export interface NotificationDeliveryStore {
  claim(input: WorkItemNotificationInput, recipient: string): Promise<boolean>;
  markSent(workItemId: string, recipient: string): Promise<void>;
  markFailed(workItemId: string, recipient: string, category: string): Promise<void>;
  isSent(workItemId: string, recipient: string): Promise<boolean>;
  listRetryable(recipient: string): Promise<WorkItemNotificationInput[]>;
}

const LEASE_MS = 10 * 60 * 1000;
const deliveryKey = (workItemId: string, recipient: string): string => `${workItemId}:WORK_ITEM:SMTP:${recipient}`;
interface NotificationRow { id: string; status: string; last_attempted_at: string | Date | null; attempt_count: number; }

export class KnexNotificationDeliveryStore implements NotificationDeliveryStore {
  public constructor(private readonly database: Knex = db) {}
  public async claim(input: WorkItemNotificationInput, recipient: string): Promise<boolean> {
    const key = deliveryKey(input.workItemId, recipient);
    return this.database.transaction(async (trx) => {
      await trx('email_notification_deliveries').insert({ work_item_id: input.workItemId, notification_type: 'WORK_ITEM', channel: 'SMTP', recipient, status: 'PENDING', idempotency_key: key }).onConflict('idempotency_key').ignore();
      const row = await trx('email_notification_deliveries').where({ idempotency_key: key }).forUpdate().first() as unknown as NotificationRow | undefined;
      if (!row || row.status === 'SENT') return false;
      const attempted = row.last_attempted_at ? new Date(row.last_attempted_at).getTime() : 0;
      if (row.status === 'SENDING' && Date.now() - attempted < LEASE_MS) return false;
      await trx('email_notification_deliveries').where({ id: row.id }).update({ status: 'SENDING', attempt_count: Number(row.attempt_count ?? 0) + 1, last_attempted_at: new Date(), updated_at: new Date() });
      return true;
    });
  }
  public async markSent(workItemId: string, recipient: string): Promise<void> { await this.database('email_notification_deliveries').where({ idempotency_key: deliveryKey(workItemId, recipient) }).update({ status: 'SENT', sent_at: new Date(), updated_at: new Date(), last_error_category: null }); }
  public async markFailed(workItemId: string, recipient: string, category: string): Promise<void> { await this.database('email_notification_deliveries').where({ idempotency_key: deliveryKey(workItemId, recipient) }).update({ status: 'FAILED', last_error_category: category, updated_at: new Date() }); }
  public async isSent(workItemId: string, recipient: string): Promise<boolean> { const row = await this.database('email_notification_deliveries').select('status').where({ idempotency_key: deliveryKey(workItemId, recipient) }).first() as unknown as Pick<NotificationRow, 'status'> | undefined; return row?.status === 'SENT'; }
  public async listRetryable(recipient: string): Promise<WorkItemNotificationInput[]> {
    const rows: unknown = await this.database('email_notification_deliveries as d').join('email_escalation_work_items as w', 'w.id', 'd.work_item_id').join('email_classification_results as c', 'c.id', 'w.classification_result_id').select('w.id as workItemId', 'c.id as classificationId', 'w.work_type as workType', 'c.classification_label as classificationLabel', 'c.confidence', 'c.mailbox_address as mailboxAddress', 'c.provider_message_id as providerMessageId', 'c.source_reference as sourceReference', 'c.classified_at as classifiedAt', 'w.resolution_deadline as resolutionDeadline', 'c.reason as classifierReason').where('d.recipient', recipient).whereIn('d.status', ['PENDING', 'FAILED', 'SENDING']);
    return Array.isArray(rows) ? rows as WorkItemNotificationInput[] : [];
  }
}

export class SmtpWorkItemNotifier implements WorkItemNotifier {
  private transporter: Transporter | undefined;

  public constructor(
    private readonly recipient: string | undefined = env.WORK_ITEM_NOTIFICATION_RECIPIENT,
    private readonly store: NotificationDeliveryStore = new KnexNotificationDeliveryStore(),
  ) {}

  public async hasNotificationBeenSent(workItemId: string): Promise<boolean> {
    if (!this.recipient) return false;
    return this.store.isSent(workItemId, this.recipient);
  }

  public async recoverPendingNotifications(): Promise<number> {
    if (!this.recipient) return 0;
    const pending = await this.store.listRetryable(this.recipient);
    let sent = 0;
    for (const input of pending) if (await this.sendNotification(input)) sent += 1;
    return sent;
  }

  public async sendNotification(input: WorkItemNotificationInput): Promise<boolean> {
    if (!this.recipient) throw new Error('Work item notification recipient is not configured.');
    const claimed = await this.store.claim(input, this.recipient);
    if (!claimed) return false;
    if (!env.SMTP_HOST) {
      await this.store.markFailed(input.workItemId, this.recipient, 'smtp_not_configured');
      throw new Error('SMTP is not configured for work item notifications.');
    }

    return this.deliverClaimed(input);
  }

  private async deliverClaimed(input: WorkItemNotificationInput): Promise<boolean> {
    const recipient = this.recipient!;

    this.transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {}),
    });

    const workTypeLabel = input.workType === 'ESCALATION' ? 'Escalation Required' : 'Review Required';
    const labelDisplay = input.classificationLabel.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const subject = `[TruFinity] ${workTypeLabel}: ${labelDisplay} — ${input.mailboxAddress}`;

    const fromLine = input.senderName
      ? `${input.senderName} <${input.senderEmail ?? 'unknown'}>`
      : (input.senderEmail ?? 'Unknown sender');

    const receivedLine = input.internalDate
      ? input.internalDate.toUTCString()
      : 'Unknown';

    const gmailSearchUrl = input.rfc822MessageId
      ? `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(input.rfc822MessageId.replace(/^<|>$/g, ''))}`
      : null;

    const lines: string[] = [
      `${workTypeLabel}: ${labelDisplay}`,
      `Customer email in ${input.mailboxAddress} has been flagged and requires attention.`,
      '',
      '--- Original Email ---',
      `From:     ${fromLine}`,
      `Subject:  ${input.subject ?? '(not available)'}`,
      `Received: ${receivedLine}`,
      '',
      '--- Why This Was Flagged ---',
      input.classifierReason ?? '(reason not available)',
      '',
      '--- Classification ---',
      `Label:       ${input.classificationLabel}`,
      `Confidence:  ${Math.round(input.confidence * 100)}%`,
      '',
      '--- Work Item ---',
      `Type:           ${workTypeLabel}`,
      `Work Item ID:   ${input.workItemId}`,
      `Resolution By:  ${input.resolutionDeadline.toUTCString()}`,
      '',
      '--- Open Original Email ---',
      `Mailbox: ${input.mailboxAddress}`,
      `Open/search this message in the mailbox above:`,
      ...(gmailSearchUrl ? [
        gmailSearchUrl,
        '',
        `Fallback search query: rfc822msgid:${input.rfc822MessageId ?? ''}`,
      ] : [
        `(no search link — Message ID: ${input.providerMessageId})`,
      ]),
    ];
    const text = lines.join('\n');

    try {
      await this.transporter.sendMail({
        from: env.MAIL_FROM,
        to: recipient,
        subject,
        text,
      });
    } catch (error) {
      await this.store.markFailed(input.workItemId, recipient, 'smtp_send_failed');
      throw new Error('Work item notification delivery failed.', { cause: error });
    }

    try {
      await this.store.markSent(input.workItemId, recipient);
      return true;
    } catch (error) {
      await this.store.markFailed(input.workItemId, recipient, 'smtp_send_failed');
      throw new Error('Work item notification delivery failed.', { cause: error });
    }
  }
}

export class NoOpWorkItemNotifier implements WorkItemNotifier {
  public sendNotification(): Promise<boolean> { return Promise.resolve(false); }
  public hasNotificationBeenSent(): Promise<boolean> { return Promise.resolve(false); }
}
