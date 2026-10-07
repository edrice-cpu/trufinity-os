import { googleWorkspaceDirectoryService, type DiscoveredWorkspaceMailbox } from '../modules/google/workspace-directory.service';

const APPROVED_SHARED_MAILBOXES = [
  'service@trufinity.ca',
  'support@trufinity.ca',
  'billing@trufinity.ca',
] as const;

export interface GoogleMailboxDiscoveryResult {
  eligibleMailboxCount: number;
  primaryEmailAddresses: string[];
  approvedSharedMailboxDiscovery: Record<(typeof APPROVED_SHARED_MAILBOXES)[number], boolean>;
}

type DirectoryDiscovery = Pick<typeof googleWorkspaceDirectoryService, 'discoverActiveMailboxes'>;

export async function runGoogleWorkspaceMailboxDiscovery(
  directoryService: DirectoryDiscovery = googleWorkspaceDirectoryService,
): Promise<GoogleMailboxDiscoveryResult> {
  const mailboxes = await directoryService.discoverActiveMailboxes();
  const primaryEmailAddresses = mailboxes.map((mailbox: DiscoveredWorkspaceMailbox) => mailbox.primaryEmail);
  const discoveredAddresses = new Set(primaryEmailAddresses);

  return {
    eligibleMailboxCount: primaryEmailAddresses.length,
    primaryEmailAddresses,
    approvedSharedMailboxDiscovery: {
      'service@trufinity.ca': discoveredAddresses.has('service@trufinity.ca'),
      'support@trufinity.ca': discoveredAddresses.has('support@trufinity.ca'),
      'billing@trufinity.ca': discoveredAddresses.has('billing@trufinity.ca'),
    },
  };
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof Error && (
    error.message === 'Google service-account credentials are not configured.'
    || error.message === 'Google delegated subject is not configured.'
  )) return error.message;

  if (typeof error === 'object' && error !== null) {
    const response = (error as { response?: { status?: unknown } }).response;
    if (typeof response?.status === 'number') {
      return `Google Admin Directory request failed with HTTP ${response.status}. Verify Domain-Wide Delegation, Admin SDK access, and delegated-user permissions.`;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return `Google Admin Directory request failed (${code}).`;
  }

  return 'Google Admin Directory authentication or permission request failed. Verify service-account configuration and Domain-Wide Delegation.';
}

async function main(): Promise<void> {
  try {
    const result = await runGoogleWorkspaceMailboxDiscovery();
    console.log(`Eligible Gmail synchronization mailbox count: ${result.eligibleMailboxCount}`);
    for (const address of result.primaryEmailAddresses) console.log(address);
    for (const address of APPROVED_SHARED_MAILBOXES) {
      const status = result.approvedSharedMailboxDiscovery[address] ? 'DISCOVERED' : 'NOT_DISCOVERED';
      console.log(`${address}: ${status}`);
    }
  } catch (error) {
    console.error(`Google Workspace mailbox discovery failed: ${safeFailureMessage(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();