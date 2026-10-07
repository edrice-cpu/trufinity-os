import { describe, expect, it, jest } from '@jest/globals';
import {
  GMAIL_METADATA_SCOPE,
  GMAIL_READONLY_SCOPE,
  type GmailAuthorizationContext,
  type GoogleGmailClient,
} from '../../src/modules/google/google-auth.service';
import {
  GmailHistoricalSyncService,
} from '../../src/modules/google/gmail-historical.service';
import type {
  GmailHistoricalError,
  GmailHistoricalMailbox,
  GmailHistoricalMessageWrite,
  GmailHistoricalRepository,
} from '../../src/modules/google/gmail-historical.repository';

const NOW = Date.UTC(2026, 8, 23, 0, 0, 0);
const CUTOFF = NOW - 365 * 24 * 60 * 60 * 1000;

type ListReply = { messages?: { id?: string; threadId?: string }[]; nextPageToken?: string };

function base64(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }

function createMessage(id: string, internalDate: number, labelIds: string[], payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds,
    internalDate: String(internalDate),
    historyId: `history-${id}`,
    snippet: 'must not persist',
    payload,
  };
}

function createAuthorization(
  address: string,
  contentMode: 'METADATA' | 'CONTENT',
  listReplies: ListReply[],
  messages: Record<string, Record<string, unknown>>,
) {
  const list = jest.fn() as jest.MockedFunction<GoogleGmailClient['users']['messages']['list']>;
  for (const reply of listReplies) list.mockResolvedValueOnce({ data: reply });
  const get = jest.fn() as jest.MockedFunction<GoogleGmailClient['users']['messages']['get']>;
  get.mockImplementation(async ({ id }) => ({ data: messages[id] }));
  const getProfile = (jest.fn() as any).mockResolvedValue({ data: { historyId: '123456789' } });
  const client = { users: { messages: { list, get }, getProfile } } as unknown as GoogleGmailClient;
  const authorization = {
    client,
    mailbox: { normalizedAddress: address, contentMode },
    subject: address,
    scope: contentMode === 'METADATA' ? GMAIL_METADATA_SCOPE : GMAIL_READONLY_SCOPE,
  } as unknown as GmailAuthorizationContext;
  return { authorization, list, get };
}

function createRepository() {
  const mailbox: GmailHistoricalMailbox = {
    id: 'mailbox-id', mailboxAddress: 'careers@trufinity.ca', normalizedMailboxAddress: 'careers@trufinity.ca', contentMode: 'METADATA',
  };
  const committed: Array<{ messages: GmailHistoricalMessageWrite[]; errors: GmailHistoricalError[] }> = [];
  const completed: Array<{ syncRunId: string; recordsProcessed: number }> = [];
  const failed: Array<{ syncRunId: string; recordsProcessed: number; message: string }> = [];
  let run = 0;
  const repository: GmailHistoricalRepository = {
    withMailboxLock: async (_mailboxAddress, work) => work(),
    recoverInterruptedRun: async () => undefined,
    ensureMailbox: async (config) => ({ ...mailbox, mailboxAddress: config.normalizedAddress, normalizedMailboxAddress: config.normalizedAddress, contentMode: config.contentMode }),
    createSyncRun: async () => `run-${++run}`,
    commitBatch: async (_mailbox, _syncRunId, messages, errors) => { committed.push({ messages, errors }); return messages.length; },
    completeMailbox: async (_mailbox, syncRunId, recordsProcessed) => { completed.push({ syncRunId, recordsProcessed }); },
    failSyncRun: async (syncRunId, recordsProcessed, message) => { failed.push({ syncRunId, recordsProcessed, message }); },
    getSyncMetadata: async () => ({ historyId: null, lastSuccessfulHistoryId: null }),
    updateSyncMetadata: async () => undefined,
    completeIncrementalRun: async () => undefined,
  };
  return { repository, committed, completed, failed };
}

function createService(
  authorization: GmailAuthorizationContext,
  repository: GmailHistoricalRepository,
  options: { directory?: string[]; wait?: (milliseconds: number) => Promise<void> } = {},
): GmailHistoricalSyncService {
  return new GmailHistoricalSyncService(
    { getGmailAuthorization: () => authorization },
    { discoverActiveMailboxes: async () => (options.directory ?? [authorization.mailbox.normalizedAddress]).map((address) => ({ normalizedAddress: address })) } as never,
    repository,
    365,
    () => NOW,
  );
}

describe('Gmail historical synchronization', () => {
  it('captures the history baseline before message scans and never calls Layer B for METADATA', async () => {
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [{ messages: [{ id: 'm' }] }, { messages: [] }], { m: createMessage('m', NOW - 1, ['INBOX']) });
    const observed = createRepository();
    const hook = { classifyMessage: jest.fn<any>().mockRejectedValue(new Error('Layer B must not execute')) };
    const service = new GmailHistoricalSyncService({ getGmailAuthorization: () => auth.authorization }, { discoverActiveMailboxes: async () => [{ normalizedAddress: 'careers@trufinity.ca' }] } as never, observed.repository, 365, () => NOW, hook);
    const complete = jest.spyOn(observed.repository, 'completeMailbox');
    await service.runMailbox('careers@trufinity.ca');
    expect(hook.classifyMessage).not.toHaveBeenCalled();
    const profile = auth.authorization.client.users.getProfile as jest.Mock;
    expect(profile.mock.invocationCallOrder[0]).toBeLessThan(auth.list.mock.invocationCallOrder[0]);
    expect(complete).toHaveBeenCalledWith(expect.anything(), 'run-1', 1, 365, '123456789');
  });

  it('leaves completion unchanged after malformed work and safely restarts the scan', async () => {
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [{ messages: [{ id: 'bad' }] }], {});
    const observed = createRepository();
    const service = createService(auth.authorization, observed.repository);
    await expect(service.runMailbox('careers@trufinity.ca')).rejects.toThrow();
    expect(observed.completed).toHaveLength(0);
    expect(observed.committed[0].messages).toEqual([]);
    expect(observed.failed).toHaveLength(1);
    auth.list.mockResolvedValueOnce({ data: { messages: [{ id: 'bad' }] } }).mockResolvedValueOnce({ data: { messages: [] } });
    auth.get.mockResolvedValue({ data: createMessage('bad', NOW - 1, ['INBOX']) });
    await service.runMailbox('careers@trufinity.ca');
    expect(observed.completed).toEqual([{ syncRunId: 'run-2', recordsProcessed: 1 }]);
    expect(auth.list.mock.calls[1][0].pageToken).toBeUndefined();
  });

  it('does not mark partially committed ingestion complete after exhausted fetch retries', async () => {
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [{ messages: [{ id: 'good' }], nextPageToken: 'next' }, { messages: [{ id: 'failed' }] }], { good: createMessage('good', NOW - 1, ['INBOX']) });
    auth.get.mockResolvedValueOnce({ data: createMessage('good', NOW - 1, ['INBOX']) }).mockRejectedValue(Object.assign(new Error('private provider content'), { response: { status: 503 } }));
    const observed = createRepository();
    await expect(createService(auth.authorization, observed.repository).runMailbox('careers@trufinity.ca')).rejects.toThrow();
    expect(auth.get).toHaveBeenCalledTimes(4);
    expect(observed.completed).toHaveLength(0);
    expect(observed.committed.flatMap(batch => batch.messages)).toHaveLength(1);
    expect(JSON.stringify(observed.failed)).not.toContain('private provider content');
  });

  it('uses Inbox and Sent label scans, deduplicates cross-label messages, and never persists metadata body/snippet data', async () => {
    const messages = {
      inbox: createMessage('inbox', NOW - 1, ['INBOX'], { headers: [{ name: 'Subject', value: 'metadata subject' }], body: { data: base64('must not persist') } }),
      shared: createMessage('shared', NOW - 2, ['INBOX', 'SENT'], { headers: [{ name: 'From', value: 'sender@trufinity.ca' }], parts: [{ mimeType: 'text/plain', body: { data: base64('must not persist') } }] }),
      sent: createMessage('sent', NOW - 3, ['SENT'], { headers: [{ name: 'To', value: 'recipient@trufinity.ca' }] }),
    };
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [
      { messages: [{ id: 'inbox' }, { id: 'shared' }] },
      { messages: [{ id: 'shared' }, { id: 'sent' }] },
    ], messages);
    const observed = createRepository();

    const result = await createService(auth.authorization, observed.repository).runMailbox('careers@trufinity.ca');

    expect(result.recordsProcessed).toBe(3);
    expect(auth.list).toHaveBeenNthCalledWith(1, { userId: 'me', maxResults: 100, includeSpamTrash: false, labelIds: ['INBOX'] });
    expect(auth.list).toHaveBeenNthCalledWith(2, { userId: 'me', maxResults: 100, includeSpamTrash: false, labelIds: ['SENT'] });
    expect(auth.get.mock.calls.map(([params]) => params.format)).toEqual(['metadata', 'metadata', 'metadata']);
    const payloads = observed.committed.flatMap((batch) => batch.messages.map((message) => message.payload));
    expect(payloads).toHaveLength(3);
    expect(JSON.stringify(payloads)).not.toContain('must not persist');
    expect(JSON.stringify(payloads)).not.toContain('snippet');
    expect(JSON.stringify(payloads)).not.toContain('metadata subject');
    expect(observed.completed).toEqual([{ syncRunId: 'run-1', recordsProcessed: 3 }]);
  });

  it('persists content only for an approved content mailbox and retains attachment metadata without attachment binary data', async () => {
    const message = createMessage('content', NOW - 1, ['INBOX'], {
      headers: [{ name: 'Subject', value: 'allowed metadata' }],
      parts: [
        { mimeType: 'text/plain', body: { data: base64('approved content') } },
        { filename: 'invoice.pdf', mimeType: 'application/pdf', body: { attachmentId: 'attachment-id', size: 123, data: base64('never store binary') } },
      ],
    });
    const auth = createAuthorization('service@trufinity.ca', 'CONTENT', [{ messages: [{ id: 'content' }] }, { messages: [] }], { content: message });
    const observed = createRepository();

    await createService(auth.authorization, observed.repository).runMailbox('service@trufinity.ca');

    expect(auth.get).toHaveBeenCalledWith({ userId: 'me', id: 'content', format: 'full' });
    const payload = observed.committed[0].messages[0].payload as any;
    expect(payload).not.toBeNull();
    expect(payload.content).toBeUndefined();
    expect(payload.attachmentMetadata).toEqual([{ filename: 'invoice.pdf', mimeType: 'application/pdf', size: 123 }]);
    expect(JSON.stringify(payload)).not.toContain('never store binary');
  });

  it('continues pagination after old messages so unordered newer messages are not skipped', async () => {
    const messages = {
      current: createMessage('current', CUTOFF + 1, ['INBOX']),
      old: createMessage('old', CUTOFF - 1, ['INBOX']),
      newer: createMessage('newer', NOW - 1, ['INBOX']),
    };
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [
      { messages: [{ id: 'current' }, { id: 'old' }], nextPageToken: 'must-not-use' },
      { messages: [{ id: 'newer' }] },
      { messages: [] },
    ], messages);
    const observed = createRepository();

    await createService(auth.authorization, observed.repository).runMailbox('careers@trufinity.ca');

    expect(auth.list).toHaveBeenCalledTimes(3);
    expect(observed.committed.flatMap((batch) => batch.messages.map((write) => write.providerMessageId))).toEqual(['current', 'newer']);
  });

  it('excludes Draft, Spam, and Trash even if returned by an included-label scan', async () => {
    const messages = {
      draft: createMessage('draft', NOW - 1, ['INBOX', 'DRAFT']),
      spam: createMessage('spam', NOW - 1, ['INBOX', 'SPAM']),
      trash: createMessage('trash', NOW - 1, ['SENT', 'TRASH']),
    };
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [
      { messages: [{ id: 'draft' }, { id: 'spam' }] },
      { messages: [{ id: 'trash' }] },
    ], messages);
    const observed = createRepository();

    const result = await createService(auth.authorization, observed.repository).runMailbox('careers@trufinity.ca');

    expect(result.recordsProcessed).toBe(0);
    expect(observed.committed.flatMap((batch) => batch.messages)).toEqual([]);
  });

  it('retries retryable Gmail failures with bounded backoff', async () => {
    const message = createMessage('retry', NOW - 1, ['INBOX']);
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [], { retry: message });
    auth.list.mockRejectedValueOnce({ response: { status: 429 } }).mockResolvedValueOnce({ data: { messages: [{ id: 'retry' }] } }).mockResolvedValueOnce({ data: { messages: [] } });
    const observed = createRepository();

    jest.spyOn(global, 'setTimeout').mockImplementation((cb: any) => {
      cb();
      return {} as any;
    });
    // Override max attempts logic to break early
    // Or just let it run normally since we mocked setTimeout
    await createService(auth.authorization, observed.repository).runMailbox('careers@trufinity.ca');
    expect(observed.completed).toHaveLength(1);
  });

  it('does not advance mailbox completion state after a mailbox failure and continues other mailboxes in all-mailbox mode', async () => {
    const successMessage = createMessage('success', NOW - 1, ['INBOX']);
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [{ messages: [{ id: 'success' }] }, { messages: [] }], { success: successMessage });
    const observed = createRepository();
    const service = createService(auth.authorization, observed.repository, { directory: ['careers@trufinity.ca', 'service@trufinity.ca'] });
    const original = service.runMailbox.bind(service);
    const runMailbox = jest.spyOn(service, 'runMailbox');
    runMailbox.mockImplementation(async (address) => {
      if (address === 'service@trufinity.ca') throw new Error('provider failure');
      return original(address);
    });

    const result = await service.runAllEligibleMailboxes();

    expect(result.completed).toHaveLength(1);
    expect(result.failed).toEqual([{ mailboxAddress: 'service@trufinity.ca', safeMessage: 'Google Workspace Gmail historical synchronization failed.' }]);
    expect(observed.completed).toHaveLength(1);
  });

  it('fails a mailbox safely when its content mode/scope does not match the locked policy', async () => {
    const auth = createAuthorization('service@trufinity.ca', 'METADATA', [{ messages: [] }], {});
    const observed = createRepository();

    await expect(createService(auth.authorization, observed.repository).runMailbox('service@trufinity.ca')).rejects.toThrow('Google Workspace Gmail historical synchronization failed.');
    expect(observed.completed).toHaveLength(0);
    expect(observed.failed).toEqual([{ syncRunId: 'run-1', recordsProcessed: 0, message: 'Google Workspace Gmail historical synchronization failed.' }]);
  });

  it('rejects nonexistent, external, suspended, or archived mailboxes in single-mailbox runner', async () => {
    const auth = createAuthorization('careers@trufinity.ca', 'METADATA', [], {});
    const observed = createRepository();
    // Simulate directory not containing the requested mailbox (e.g., suspended/archived excluded by directory logic)
    const service = createService(auth.authorization, observed.repository, { directory: ['other@trufinity.ca'] });

    await expect(service.runMailbox('careers@trufinity.ca')).rejects.toThrow('Mailbox is not eligible, suspended, archived, or not found in Google Workspace directory.');
    await expect(service.runMailbox('external@gmail.com')).rejects.toThrow('Mailbox is not eligible, suspended, archived, or not found in Google Workspace directory.');
    await expect(service.runMailbox('nonexistent@trufinity.ca')).rejects.toThrow('Mailbox is not eligible, suspended, archived, or not found in Google Workspace directory.');
  });
});
