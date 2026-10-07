import { describe, expect, it, jest } from '@jest/globals';
import {
  GMAIL_METADATA_SCOPE,
  GMAIL_READONLY_SCOPE,
  GOOGLE_ADMIN_DIRECTORY_USERS_READONLY_SCOPE,
  GoogleWorkspaceAuthService,
  type GoogleAuthFactory,
  type GoogleDirectoryUsersClient,
  type GoogleGmailClient,
} from '../../src/modules/google/google-auth.service';
import { GoogleWorkspaceDirectoryService } from '../../src/modules/google/workspace-directory.service';

const config = {
  projectId: 'test-project',
  serviceAccountEmail: 'service-account@test-project.iam.gserviceaccount.com',
  serviceAccountPrivateKey: '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----',
  adminDelegatedUser: 'admin@trufinity.ca',
};

describe('Google Workspace Domain-Wide Delegation', () => {
  it('uses GOOGLE_ADMIN_DELEGATED_USER only for Admin SDK discovery', () => {
    const calls: Array<{ subject: string; scopes: readonly string[] }> = [];
    const factory: GoogleAuthFactory = {
      createJwt: (options) => { calls.push({ subject: options.subject, scopes: options.scopes }); return {}; },
      createAdminClient: () => ({ list: jest.fn() as unknown as GoogleDirectoryUsersClient['list'] }),
      createGmailClient: () => ({} as GoogleGmailClient),
    };
    const service = new GoogleWorkspaceAuthService(config, factory);
    service.getAdminDirectoryClient();
    expect(calls).toEqual([{ subject: 'admin@trufinity.ca', scopes: [GOOGLE_ADMIN_DIRECTORY_USERS_READONLY_SCOPE] }]);
  });

  it('dynamically impersonates each mailbox with metadata-only scope for normal mailboxes', () => {
    const calls: Array<{ subject: string; scopes: readonly string[] }> = [];
    const factory: GoogleAuthFactory = {
      createJwt: (options) => { calls.push({ subject: options.subject, scopes: options.scopes }); return {}; },
      createAdminClient: () => ({ list: jest.fn() as unknown as GoogleDirectoryUsersClient['list'] }),
      createGmailClient: () => ({} as GoogleGmailClient),
    };
    const service = new GoogleWorkspaceAuthService(config, factory);
    expect(service.getGmailAuthorization('finance@trufinity.ca')).toMatchObject({ subject: 'finance@trufinity.ca', scope: GMAIL_METADATA_SCOPE });
    expect(service.getGmailAuthorization('operations@trufinity.ca')).toMatchObject({ subject: 'operations@trufinity.ca', scope: GMAIL_METADATA_SCOPE });
    expect(calls).toEqual([
      { subject: 'finance@trufinity.ca', scopes: [GMAIL_METADATA_SCOPE] },
      { subject: 'operations@trufinity.ca', scopes: [GMAIL_METADATA_SCOPE] },
    ]);
  });

  it('uses readonly content scope only for the three approved mailboxes', () => {
    const calls: Array<{ subject: string; scopes: readonly string[] }> = [];
    const factory: GoogleAuthFactory = {
      createJwt: (options) => { calls.push({ subject: options.subject, scopes: options.scopes }); return {}; },
      createAdminClient: () => ({ list: jest.fn() as unknown as GoogleDirectoryUsersClient['list'] }),
      createGmailClient: () => ({} as GoogleGmailClient),
    };
    const service = new GoogleWorkspaceAuthService(config, factory);
    expect(service.getGmailAuthorization('SERVICE@TRUFINITY.CA').scope).toBe(GMAIL_READONLY_SCOPE);
    expect(service.getGmailAuthorization('support@trufinity.ca').scope).toBe(GMAIL_READONLY_SCOPE);
    expect(service.getGmailAuthorization('billing@trufinity.ca').scope).toBe(GMAIL_READONLY_SCOPE);
    expect(service.getGmailAuthorization('finance@trufinity.ca').scope).toBe(GMAIL_METADATA_SCOPE);
    expect(calls.map((call) => call.subject)).toEqual([
      'service@trufinity.ca', 'support@trufinity.ca', 'billing@trufinity.ca', 'finance@trufinity.ca',
    ]);
  });

  it('does not expose credential values and rejects missing runtime credentials', () => {
    const service = new GoogleWorkspaceAuthService({ ...config, serviceAccountPrivateKey: '' });
    expect(() => service.getGmailAuthorization('finance@trufinity.ca')).toThrow('credentials are not configured');
  });
});

describe('Google Workspace mailbox discovery', () => {
  it('paginates eligible company users, excludes suspended/archived/guest/external users, and applies policy', async () => {
    const list = jest.fn() as jest.MockedFunction<GoogleDirectoryUsersClient['list']>;
    list.mockResolvedValueOnce({ data: { users: [
        { primaryEmail: 'Finance@trufinity.ca' },
        { primaryEmail: 'suspended@trufinity.ca', suspended: true },
        { primaryEmail: 'archived@trufinity.ca', archived: true },
      ], nextPageToken: 'next' } })
      .mockResolvedValueOnce({ data: { users: [
        { primaryEmail: 'service@trufinity.ca' },
        { primaryEmail: 'finance@trufinity.ca' },
        { primaryEmail: 'guest@partner.guest.google' },
        { primaryEmail: 'external@example.com' },
      ] } });
    const directory = new GoogleWorkspaceDirectoryService(
      { getAdminDirectoryClient: () => ({ list }) },
    );
    await expect(directory.discoverActiveMailboxes()).resolves.toEqual([
      expect.objectContaining({ normalizedAddress: 'finance@trufinity.ca', contentMode: 'METADATA' }),
      expect.objectContaining({ normalizedAddress: 'service@trufinity.ca', contentMode: 'CONTENT' }),
    ]);
    expect(list).toHaveBeenNthCalledWith(1, expect.objectContaining({ customer: 'my_customer', maxResults: 500 }));
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: 'next' }));
  });
});
