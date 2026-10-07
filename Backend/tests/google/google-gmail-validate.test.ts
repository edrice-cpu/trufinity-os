import { describe, it, expect, jest } from '@jest/globals';
import { validateSample } from '../../src/scripts/google-gmail-validate';

function fixture() {
  const list = jest.fn<any>().mockResolvedValue({ data: { messages: Array.from({ length: 9 }, (_, i) => ({ id: `${i + 1}` })) } });
  const get = jest.fn<any>().mockImplementation(async ({ id }: any) => ({ data: { id, threadId: 'thread', internalDate: '1700000000000', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'SECRET' }, { name: 'From', value: 'sender@example.com' }], body: { data: 'SECRET' } }, snippet: 'SECRET' } }));
  const update = jest.fn<any>().mockResolvedValue(1);
  const database = Object.assign(jest.fn<any>().mockImplementation(() => ({ where: () => ({ first: async () => ({ id: 'mb', mailbox_address: 'careers@trufinity.ca', normalized_mailbox_address: 'careers@trufinity.ca' }), update }) })), { fn: { now: () => 'now' } });
  const repository = { withMailboxLock: jest.fn<any>().mockImplementation(async (_: any, work: any) => work()), createSyncRun: jest.fn<any>().mockResolvedValue('run'), commitBatch: jest.fn<any>().mockResolvedValue(5), failSyncRun: jest.fn<any>() };
  const auth = { getGmailAuthorization: jest.fn<any>().mockReturnValue({ scope: 'https://www.googleapis.com/auth/gmail.metadata', subject: 'careers@trufinity.ca', client: { users: { messages: { list, get } } } }) };
  return { dependencies: { database, repository, auth, classifierEnabled: false } as any, list, get, database, repository };
}

describe('bounded Layer A validation', () => {
  it('hard caps at five and persists sanitized metadata without checkpoint writes', async () => {
    const f = fixture();
    const result = await validateSample('careers@trufinity.ca', undefined, f.dependencies);
    expect(result.ids).toEqual(['1', '2', '3', '4', '5']);
    expect(f.get).toHaveBeenCalledTimes(5);
    expect(f.get).toHaveBeenCalledWith({ userId: 'me', id: '1', format: 'metadata' });
    expect(JSON.stringify(f.repository.commitBatch.mock.calls)).not.toContain('SECRET');
    expect(f.repository.commitBatch.mock.calls[0]).toHaveLength(4);
    expect(f.database.mock.calls.map(call => call[0])).toEqual(['google_gmail_mailboxes', 'sync_runs']);
  });
  it('replays exact IDs without listing or selecting new messages', async () => {
    const f = fixture();
    await validateSample('careers@trufinity.ca', ['a', 'b'], f.dependencies);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.get.mock.calls.map(call => (call[0] as { id: string }).id)).toEqual(['a', 'b']);
  });
  it('refuses CONTENT, enabled classifier, oversized and duplicate replay before I/O', async () => {
    const f = fixture();
    await expect(validateSample('service@trufinity.ca', undefined, f.dependencies)).rejects.toThrow();
    await expect(validateSample('careers@trufinity.ca', undefined, { ...f.dependencies, classifierEnabled: true })).rejects.toThrow();
    await expect(validateSample('careers@trufinity.ca', ['1', '2', '3', '4', '5', '6'], f.dependencies)).rejects.toThrow();
    await expect(validateSample('careers@trufinity.ca', ['1', '1'], f.dependencies)).rejects.toThrow();
    expect(f.dependencies.auth.getGmailAuthorization).not.toHaveBeenCalled();
  });
  it('fetch failure persists nothing and cannot complete a normal sync', async () => {
    const f = fixture();
    f.get.mockRejectedValue(new Error('private provider payload'));
    await expect(validateSample('careers@trufinity.ca', ['1'], f.dependencies)).rejects.toThrow();
    expect(f.repository.createSyncRun).not.toHaveBeenCalled();
    expect(f.repository.commitBatch).not.toHaveBeenCalled();
  });
});
