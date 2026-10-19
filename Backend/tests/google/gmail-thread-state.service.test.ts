import { describe, expect, it } from '@jest/globals';
import {
  extractGmailMessageFact,
  projectGmailDirectionMetadata,
  recomputeGmailThreadState,
  refreshGmailThreadState,
} from '../../src/modules/google/gmail-thread-state.service';

const date = (value: string) => new Date(`2026-01-01T00:${value}:00.000Z`);
const payload = (labelIds: string[], from: string) => ({
  labelIds,
  headers: [{ name: 'From', value: from }],
});

describe('Gmail derived thread state', () => {
  it('extracts direction metadata without retaining Gmail content', () => {
    const fact = extractGmailMessageFact({
      mailboxId: 'mb-1', mailboxAddress: 'service@trufinity.ca', providerMessageId: 'm-1',
      threadId: 'thread-1', internalDate: date('01'),
      payload: payload(['INBOX'], 'customer@example.com'), isDeleted: false,
    });
    expect(fact).toMatchObject({ direction: 'INBOUND', providerMessageId: 'm-1' });
    expect(fact).not.toHaveProperty('payload');
  });

  it('preserves direction when projecting away non-classification payload fields', () => {
    const fullPayload = {
      ...payload(['INBOX'], 'customer@example.com'),
      subject: 'private subject', body: 'private body', snippet: 'private snippet',
      html: '<p>private</p>', attachments: [{ name: 'private.txt' }],
    };
    expect(projectGmailDirectionMetadata(fullPayload)).toEqual(payload(['INBOX'], 'customer@example.com'));
    const base = {
      mailboxId: 'mb-1', mailboxAddress: 'service@trufinity.ca', providerMessageId: 'm-1',
      threadId: 'thread-1', internalDate: date('01'), isDeleted: false,
    };
    expect(extractGmailMessageFact({ ...base, payload: fullPayload })?.direction)
      .toBe(extractGmailMessageFact({ ...base, payload: projectGmailDirectionMetadata(fullPayload) })?.direction);
  });

  it('recomputes pending state after a reply and includes unknown activity', () => {
    const facts = [
      extractGmailMessageFact({ mailboxId: 'mb-1', mailboxAddress: 'service@trufinity.ca', providerMessageId: 'in', threadId: 't', internalDate: date('01'), payload: payload(['INBOX'], 'customer@example.com'), isDeleted: false })!,
      extractGmailMessageFact({ mailboxId: 'mb-1', mailboxAddress: 'service@trufinity.ca', providerMessageId: 'out', threadId: 't', internalDate: date('02'), payload: payload(['SENT'], 'team@trufinity.ca'), isDeleted: false })!,
      extractGmailMessageFact({ mailboxId: 'mb-1', mailboxAddress: 'service@trufinity.ca', providerMessageId: 'unknown', threadId: 't', internalDate: date('03'), payload: { labelIds: ['DRAFT'] }, isDeleted: false })!,
    ];
    const state = recomputeGmailThreadState('mb-1', 'service@trufinity.ca', 't', facts);
    expect(state).toMatchObject({ hasUnanswered: false, messageCount: 3, classifiedMessageCount: 2, lastOutboundMessageId: 'out' });
    expect(state?.lastActivityAt).toEqual(date('03'));
  });

  it('returns no fact for a deletion or missing thread identity', () => {
    const base = { mailboxId: 'mb-1', mailboxAddress: 'service@trufinity.ca', providerMessageId: 'm', threadId: 't', internalDate: date('01'), payload: payload(['INBOX'], 'customer@example.com') };
    expect(extractGmailMessageFact({ ...base, isDeleted: true })).toBeNull();
    expect(extractGmailMessageFact({ ...base, threadId: '', isDeleted: false })).toBeNull();
  });

  it('refreshes only affected threads and deletes empty state', async () => {
    const calls: string[] = [];
    const trx = ((table: string) => {
      const query: Record<string, any> = {
        select: () => query,
        where: () => query,
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
        delete: async () => { calls.push(`${table}:delete`); return 1; },
      };
      return query;
    }) as any;
    await refreshGmailThreadState(trx, 'mb-1', ['t-1', 't-1', '']);
    expect(calls).toEqual(['google_gmail_thread_responsiveness:delete']);
  });
});
