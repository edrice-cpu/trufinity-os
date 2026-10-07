import { describe, expect, it, jest } from '@jest/globals';
import { DefaultGmailClassificationHook } from '../../src/modules/google/gmail-classification.service';

const authorization = (mode: 'CONTENT' | 'METADATA' = 'CONTENT') => ({
  subject: 'service@trufinity.ca', scope: 'scope', mailbox: { normalizedAddress: 'service@trufinity.ca', contentMode: mode },
} as any);
const message = (from = 'customer@example.com') => ({
  id: 'm1', threadId: 't1', labelIds: ['INBOX'], internalDate: new Date(), historyId: null, sizeEstimate: null,
  payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Synthetic subject' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Synthetic body').toString('base64url') } }] },
});

describe('Gmail classification hook', () => {
  it('classifies approved CONTENT inbound messages with transient input only', async () => {
    const classifier = { classify: jest.fn(async (input: { subject: string; bodyText: string }) => { expect(input).toEqual({ subject: 'Synthetic subject', bodyText: 'Synthetic body' }); return { label: 'complaint' as const, confidence: 0.9, reason: 'Synthetic reason.' }; }) };
    const result = await new DefaultGmailClassificationHook(classifier as any, true, 0.8).classifyMessage(authorization(), message(), 'mailbox-1');
    expect(result).toMatchObject({ decisionStatus: 'ESCALATION', mailboxId: 'mailbox-1', providerMessageId: 'm1' });
    expect(result?.idempotencyKey).toContain(':anthropic:');
  });

  it('does not classify outbound, metadata, or excluded messages', async () => {
    const classifier = { classify: jest.fn() };
    const hook = new DefaultGmailClassificationHook(classifier as any, true, 0.8);
    await expect(hook.classifyMessage(authorization(), message('service@trufinity.ca'))).resolves.toBeNull();
    await expect(hook.classifyMessage(authorization('METADATA'), message())).resolves.toBeNull();
    await expect(hook.classifyMessage(authorization(), { ...message(), labelIds: ['TRASH'] })).resolves.toBeNull();
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('disabled mode performs no classification', async () => {
    const classifier = { classify: jest.fn() };
    await expect(new DefaultGmailClassificationHook(classifier as any, false, 0.8).classifyMessage(authorization(), message())).resolves.toBeNull();
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it('fails safely when enabled configuration is incomplete', async () => {
    const classifier = { classify: jest.fn() };
    const hook = new DefaultGmailClassificationHook(classifier as any, true, 0.8);
    (hook as any).threshold = undefined;
    await expect(hook.classifyMessage(authorization(), message())).rejects.toThrow('confidence threshold');
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
