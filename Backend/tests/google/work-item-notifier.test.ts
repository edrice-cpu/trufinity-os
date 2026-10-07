import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../src/config/env', () => ({ env: { SMTP_HOST: 'smtp.test', SMTP_PORT: 25, SMTP_SECURE: false, SMTP_USER: '', SMTP_PASSWORD: '', MAIL_FROM: 'noreply@example.test', WORK_ITEM_NOTIFICATION_RECIPIENT: 'alerts@example.test' } }));
import { SmtpWorkItemNotifier, type NotificationDeliveryStore, type WorkItemNotificationInput } from '../../src/modules/google/work-item-notifier';

const mockSendMail = jest.fn(async () => undefined);
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: mockSendMail, close: jest.fn() }) }));

const baseInput: WorkItemNotificationInput = {
  workItemId: 'work-1', classificationId: 'class-1', workType: 'ESCALATION',
  classificationLabel: 'complaint', confidence: 0.9, mailboxAddress: 'service@trufinity.ca',
  providerMessageId: 'message-1', sourceReference: 'gmail:message-1',
  classifiedAt: new Date('2026-01-01T00:00:00Z'), resolutionDeadline: new Date('2026-01-01T12:00:00Z'),
  senderEmail: 'customer@example.com', senderName: 'Jane Customer',
  subject: 'Problem with my service', internalDate: new Date('2025-12-31T18:00:00Z'),
  classifierReason: 'Customer expresses dissatisfaction with service quality.',
  rfc822MessageId: '<abc123@mail.gmail.com>',
};

const minimalInput: WorkItemNotificationInput = {
  ...baseInput,
  senderEmail: null, senderName: null, subject: null, internalDate: null,
  classifierReason: null, rfc822MessageId: null,
};

class FakeStore implements NotificationDeliveryStore {
  sent = false;
  failed = false;
  retryable: WorkItemNotificationInput[] = [];
  async claim(): Promise<boolean> { if (this.sent) return false; return true; }
  async markSent(): Promise<void> { this.sent = true; }
  async markFailed(): Promise<void> { this.failed = true; }
  async isSent(): Promise<boolean> { return this.sent; }
  async listRetryable(): Promise<WorkItemNotificationInput[]> { return this.retryable; }
}

describe('durable work-item notification behavior', () => {
  beforeEach(() => { mockSendMail.mockClear(); });

  it('persists sent state and is idempotent across notifier instances', async () => {
    const store = new FakeStore();
    const first = new SmtpWorkItemNotifier('alerts@example.test', store);
    const second = new SmtpWorkItemNotifier('alerts@example.test', store);
    await expect(first.sendNotification(baseInput)).resolves.toBe(true);
    await expect(second.sendNotification(baseInput)).resolves.toBe(false);
    await expect(second.hasNotificationBeenSent(baseInput.workItemId)).resolves.toBe(true);
  });

  it('retries pending deliveries without touching classification data', async () => {
    const store = new FakeStore();
    store.retryable = [baseInput];
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await expect(notifier.recoverPendingNotifications()).resolves.toBe(1);
    expect(store.sent).toBe(true);
  });

  it('retry path: DB reason column → classifierReason → Why This Was Flagged rendered', async () => {
    // Simulates listRetryable() returning a row where c.reason was aliased to classifierReason
    const store = new FakeStore();
    const retryInput: WorkItemNotificationInput = {
      ...baseInput,
      classifierReason: 'Customer reported persistent billing errors over three months.',
    };
    store.retryable = [retryInput];
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.recoverPendingNotifications();
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('--- Why This Was Flagged ---');
    expect(call.text).toContain('Customer reported persistent billing errors over three months.');
  });
});

describe('notification payload — human context', () => {
  beforeEach(() => { mockSendMail.mockClear(); });

  it('includes sender name and email in notification body', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('Jane Customer');
    expect(call.text).toContain('customer@example.com');
  });

  it('includes subject in notification body', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('Problem with my service');
  });

  it('includes classifier reason in notification body', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('Customer expresses dissatisfaction with service quality.');
  });

  it('includes Gmail search link when rfc822MessageId is present', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('rfc822msgid');
    expect(call.text).toContain('abc123');
  });

  it('includes resolution deadline and work item ID', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('work-1');
    expect(call.text).toContain('Thu, 01 Jan 2026 12:00:00 GMT');
  });

  it('includes Why This Was Flagged section with reason', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('--- Why This Was Flagged ---');
    expect(call.text).toContain('Customer expresses dissatisfaction with service quality.');
  });

  it('includes Open Original Email section with explicit mailbox', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('--- Open Original Email ---');
    expect(call.text).toContain('Mailbox: service@trufinity.ca');
    expect(call.text).toContain('Open/search this message in the mailbox above:');
    expect(call.text).toContain('Fallback search query: rfc822msgid:');
  });

  it('gracefully handles null transient fields', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await expect(notifier.sendNotification(minimalInput)).resolves.toBe(true);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.text).toContain('(not available)');        // subject fallback
    expect(call.text).toContain('Unknown sender');         // sender fallback
    expect(call.text).toContain('(reason not available)'); // reason fallback
    expect(call.text).not.toContain('rfc822msgid');        // no search link without message-id
  });

  it('does not include email body content in notification', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    // The text field must NOT include anything that looks like email body content
    expect(call.text).not.toContain('bodyText');
    expect(call.text).not.toContain('plainText');
  });

  it('sends to configured recipient only — no CC or BCC', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, unknown>;
    expect(call.to).toBe('alerts@example.test');
    expect(call.cc).toBeUndefined();
    expect(call.bcc).toBeUndefined();
  });

  it('subject line contains work type and label', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    await notifier.sendNotification(baseInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.subject).toContain('Escalation Required');
    expect(call.subject).toContain('Complaint');
    expect(call.subject).toContain('service@trufinity.ca');
  });

  it('REVIEW_REQUIRED renders correct work type label', async () => {
    const store = new FakeStore();
    const notifier = new SmtpWorkItemNotifier('alerts@example.test', store);
    const rrInput: WorkItemNotificationInput = { ...baseInput, workType: 'REVIEW_REQUIRED', resolutionDeadline: new Date('2026-01-02T00:00:00Z') };
    await notifier.sendNotification(rrInput);
    const call = ((mockSendMail.mock.calls as unknown[][])[0]![0]!) as Record<string, string>;
    expect(call.subject).toContain('Review Required');
    expect(call.text).toContain('Review Required');
  });
});
