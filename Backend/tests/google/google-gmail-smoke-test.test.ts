import { describe, expect, it, jest } from '@jest/globals';
import {
  GMAIL_METADATA_SCOPE,
  GMAIL_READONLY_SCOPE,
  type GmailAuthorizationContext,
  type GoogleGmailClient,
} from '../../src/modules/google/google-auth.service';
import {
  formatGmailSmokeTestResult,
  runGoogleGmailSmokeTest,
} from '../../src/scripts/google-gmail-smoke-test';

function createAuthorization(
  subject: string,
  contentMode: 'METADATA' | 'CONTENT',
  scope: typeof GMAIL_METADATA_SCOPE | typeof GMAIL_READONLY_SCOPE,
) {
  const list = jest.fn() as jest.MockedFunction<GoogleGmailClient['users']['messages']['list']>;
  list.mockResolvedValue({ data: { messages: [{ id: 'sensitive-message-id' }] } });
  const get = jest.fn() as jest.MockedFunction<GoogleGmailClient['users']['messages']['get']>;
  get.mockResolvedValue({ data: { snippet: 'must never be printed', payload: { body: { data: 'must never be printed' } } } });
  const authorization = {
    subject,
    scope,
    mailbox: { contentMode },
    client: { users: { messages: { list, get } } },
  } as unknown as GmailAuthorizationContext;
  return { authorization, list, get };
}

describe('Google Gmail smoke-test runner', () => {
  it('dynamically impersonates the metadata mailbox and all approved content mailboxes with safe requests', async () => {
    const careers = createAuthorization('careers@trufinity.ca', 'METADATA', GMAIL_METADATA_SCOPE);
    const service = createAuthorization('service@trufinity.ca', 'CONTENT', GMAIL_READONLY_SCOPE);
    const support = createAuthorization('support@trufinity.ca', 'CONTENT', GMAIL_READONLY_SCOPE);
    const billing = createAuthorization('billing@trufinity.ca', 'CONTENT', GMAIL_READONLY_SCOPE);
    const authorizationByMailbox = new Map([
      ['careers@trufinity.ca', careers.authorization],
      ['service@trufinity.ca', service.authorization],
      ['support@trufinity.ca', support.authorization],
      ['billing@trufinity.ca', billing.authorization],
    ]);
    const getGmailAuthorization = jest.fn((mailboxAddress: string) => {
      const authorization = authorizationByMailbox.get(mailboxAddress);
      if (!authorization) throw new Error('Unexpected mailbox.');
      return authorization;
    });

    const results = await runGoogleGmailSmokeTest({ getGmailAuthorization });

    expect(getGmailAuthorization.mock.calls.map(([address]) => address)).toEqual([
      'careers@trufinity.ca',
      'service@trufinity.ca',
      'support@trufinity.ca',
      'billing@trufinity.ca',
    ]);
    for (const mailbox of [careers, service, support, billing]) {
      expect(mailbox.list).toHaveBeenCalledWith({ userId: 'me', maxResults: 1, includeSpamTrash: false });
      expect(mailbox.get).toHaveBeenCalledWith({ userId: 'me', id: 'sensitive-message-id', format: 'metadata' });
    }
    expect(results).toEqual([
      expect.objectContaining({ mailboxAddress: 'careers@trufinity.ca', expectedContentMode: 'METADATA', expectedScope: GMAIL_METADATA_SCOPE, passed: true }),
      expect.objectContaining({ mailboxAddress: 'service@trufinity.ca', expectedContentMode: 'CONTENT', expectedScope: GMAIL_READONLY_SCOPE, passed: true }),
      expect.objectContaining({ mailboxAddress: 'support@trufinity.ca', expectedContentMode: 'CONTENT', expectedScope: GMAIL_READONLY_SCOPE, passed: true }),
      expect.objectContaining({ mailboxAddress: 'billing@trufinity.ca', expectedContentMode: 'CONTENT', expectedScope: GMAIL_READONLY_SCOPE, passed: true }),
    ]);
  });

  it('returns safe output without message identifiers or message content', () => {
    const output = formatGmailSmokeTestResult({
      mailboxAddress: 'careers@trufinity.ca',
      expectedContentMode: 'METADATA',
      expectedScope: GMAIL_METADATA_SCOPE,
      passed: true,
    });
    expect(output).toBe(`careers@trufinity.ca | METADATA | ${GMAIL_METADATA_SCOPE} | PASS`);
    expect(output).not.toContain('sensitive-message-id');
    expect(output).not.toContain('must never be printed');
  });

  it('marks every mailbox as failed without surfacing a provider error', async () => {
    const results = await runGoogleGmailSmokeTest({
      getGmailAuthorization: () => { throw new Error('provider response must not be printed'); },
    });
    expect(results).toEqual([
      expect.objectContaining({ mailboxAddress: 'careers@trufinity.ca', passed: false }),
      expect.objectContaining({ mailboxAddress: 'service@trufinity.ca', passed: false }),
      expect.objectContaining({ mailboxAddress: 'support@trufinity.ca', passed: false }),
      expect.objectContaining({ mailboxAddress: 'billing@trufinity.ca', passed: false }),
    ]);
  });
});