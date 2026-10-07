import { GoogleWorkspaceAuthService, googleWorkspaceAuthService, type GoogleDirectoryUsersClient } from './google-auth.service';
import { resolveGmailMailboxPolicy } from './gmail-policy';
import type { GmailMailboxConfig } from './types';

export const TRUFINITY_WORKSPACE_DOMAIN = 'trufinity.ca';

export interface DiscoveredWorkspaceMailbox extends GmailMailboxConfig {
  primaryEmail: string;
}

export function isEligibleGmailSynchronizationMailbox(mailbox: GmailMailboxConfig): boolean {
  return mailbox.normalizedAddress.endsWith(`@${TRUFINITY_WORKSPACE_DOMAIN}`);
}

export class GoogleWorkspaceDirectoryService {
  public constructor(
    private readonly authService: Pick<GoogleWorkspaceAuthService, 'getAdminDirectoryClient'>,
    private readonly directoryClient?: GoogleDirectoryUsersClient,
  ) {}

  public async discoverActiveMailboxes(): Promise<DiscoveredWorkspaceMailbox[]> {
    const client = this.directoryClient ?? this.authService.getAdminDirectoryClient();
    const discovered: DiscoveredWorkspaceMailbox[] = [];
    let pageToken: string | undefined;
    do {
      const response = await client.list({
        customer: 'my_customer',
        maxResults: 500,
        orderBy: 'email',
        projection: 'full',
        ...(pageToken ? { pageToken } : {}),
      });
      for (const user of response.data.users ?? []) {
        if (user.suspended === true || user.archived === true || typeof user.primaryEmail !== 'string') continue;
        const mailbox = resolveGmailMailboxPolicy(user.primaryEmail);
        if (!isEligibleGmailSynchronizationMailbox(mailbox)) continue;
        discovered.push({ ...mailbox, primaryEmail: mailbox.normalizedAddress });
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    const unique = new Map(discovered.map((mailbox) => [mailbox.normalizedAddress, mailbox]));
    return [...unique.values()].sort((left, right) => left.normalizedAddress.localeCompare(right.normalizedAddress));
  }
}

export const googleWorkspaceDirectoryService = new GoogleWorkspaceDirectoryService(googleWorkspaceAuthService);