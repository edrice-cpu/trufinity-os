import { describe, expect, it, jest } from '@jest/globals';
import type { GmailMessagePart, GmailReportInboxClient } from '../../src/modules/google/google-auth.service';
import { LaceReportMailboxStore, MAILBOX_KEY_PREFIX } from '../../src/modules/lace/report-mailbox.store';

const CSV = 'CSR,Period Start,Period End\nA,2026-09-01 04:00:00,2026-09-30 21:00:00\n';

interface FakeMessage { id: string; internalDate: string; payload: GmailMessagePart }

function fakeClient(messages: FakeMessage[], attachmentData: Record<string, string>, pages = 1) {
  const list = jest.fn(async (params: { pageToken?: string }) => {
    if (pages === 2) {
      return params.pageToken
        ? { data: { messages: messages.slice(1).map((m) => ({ id: m.id })), nextPageToken: null } }
        : { data: { messages: messages.slice(0, 1).map((m) => ({ id: m.id })), nextPageToken: 'page-2' } };
    }
    return { data: { messages: messages.map((m) => ({ id: m.id })), nextPageToken: null } };
  });
  const get = jest.fn(async ({ id }: { id: string }) => ({ data: messages.find((m) => m.id === id) ?? {} }));
  const attachmentsGet = jest.fn(async ({ id }: { userId: string; messageId: string; id: string }) => ({ data: { data: attachmentData[id] ?? null } }));
  const client = { users: { messages: { list, get, attachments: { get: attachmentsGet } } } } as unknown as GmailReportInboxClient;
  return { client, list, get, attachmentsGet };
}

const b64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

const reportMessage = (id: string, parts: GmailMessagePart[]): FakeMessage => ({
  id, internalDate: '1792540800000', payload: { mimeType: 'multipart/mixed', parts },
});

describe('LaceReportMailboxStore', () => {
  it('lists only CSV attachments (including nested parts) with stable keys', async () => {
    const { client, list } = fakeClient([
      reportMessage('m1', [
        { mimeType: 'text/plain', body: { size: 10 } },
        { mimeType: 'multipart/alternative', parts: [{ filename: 'report_20261011.csv', mimeType: 'text/csv', body: { attachmentId: 'a1', size: 512 } }] },
        { filename: 'logo.png', mimeType: 'image/png', body: { attachmentId: 'a2', size: 900 } },
      ]),
    ], {});

    const objects = await new LaceReportMailboxStore(client, 'subject:"Monthly Agent Performance Report"').listObjects();

    expect(objects).toEqual([{
      key: `${MAILBOX_KEY_PREFIX}m1/report_20261011.csv`,
      eTag: 'm1:report_20261011.csv:512',
      lastModified: new Date(1792540800000),
      size: 512,
    }]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ q: 'subject:"Monthly Agent Performance Report"', includeSpamTrash: false }));
  });

  it('follows pagination', async () => {
    const { client } = fakeClient([
      reportMessage('m1', [{ filename: 'a.csv', body: { attachmentId: 'a1', size: 1 } }]),
      reportMessage('m2', [{ filename: 'b.csv', body: { attachmentId: 'b1', size: 1 } }]),
    ], {}, 2);
    const keys = (await new LaceReportMailboxStore(client, 'q').listObjects()).map((o) => o.key);
    expect(keys).toEqual(['mailbox/m1/a.csv', 'mailbox/m2/b.csv']);
  });

  it('decodes the base64url attachment and strips a BOM', async () => {
    const { client, attachmentsGet } = fakeClient(
      [reportMessage('m1', [{ filename: 'r.csv', body: { attachmentId: 'a1', size: 1 } }])],
      { a1: b64url(`\uFEFF${CSV}`) },
    );
    const store = new LaceReportMailboxStore(client, 'q');
    const [object] = await store.listObjects();

    await expect(store.getObjectText(object!.key)).resolves.toBe(CSV);
    expect(attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'm1', id: 'a1' });
  });

  it('refuses keys it did not list and empty attachments', async () => {
    const { client } = fakeClient([reportMessage('m1', [{ filename: 'r.csv', body: { attachmentId: 'a1', size: 1 } }])], {});
    const store = new LaceReportMailboxStore(client, 'q');
    await expect(store.getObjectText('mailbox/other/x.csv')).rejects.toThrow('Unknown Lace report attachment key');
    const [object] = await store.listObjects();
    await expect(store.getObjectText(object!.key)).rejects.toThrow('is empty');
  });
});
