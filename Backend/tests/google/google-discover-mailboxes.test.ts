import { describe, expect, it } from '@jest/globals';
import { runGoogleWorkspaceMailboxDiscovery } from '../../src/scripts/google-discover-mailboxes';

describe('Google Workspace mailbox-discovery runner', () => {
  it('returns only discovered addresses, their count, and approved-mailbox presence', async () => {
    const result = await runGoogleWorkspaceMailboxDiscovery({
      discoverActiveMailboxes: async () => [
        { primaryEmail: 'finance@trufinity.ca', address: 'finance@trufinity.ca', normalizedAddress: 'finance@trufinity.ca', contentMode: 'METADATA', includeFolders: ['INBOX', 'SENT'], excludeFolders: ['DRAFT', 'SPAM', 'TRASH'], storeAttachmentBinary: false },
        { primaryEmail: 'service@trufinity.ca', address: 'service@trufinity.ca', normalizedAddress: 'service@trufinity.ca', contentMode: 'CONTENT', includeFolders: ['INBOX', 'SENT'], excludeFolders: ['DRAFT', 'SPAM', 'TRASH'], storeAttachmentBinary: false },
      ],
    });

    expect(result).toEqual({
      eligibleMailboxCount: 2,
      primaryEmailAddresses: ['finance@trufinity.ca', 'service@trufinity.ca'],
      approvedSharedMailboxDiscovery: {
        'service@trufinity.ca': true,
        'support@trufinity.ca': false,
        'billing@trufinity.ca': false,
      },
    });
  });
});