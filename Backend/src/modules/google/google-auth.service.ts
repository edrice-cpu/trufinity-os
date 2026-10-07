import { google } from 'googleapis';
import { env } from '../../config/env';
import { resolveGmailMailboxPolicy } from './gmail-policy';
import type { GmailContentMode, GmailMailboxConfig } from './types';

export const GOOGLE_ADMIN_DIRECTORY_USERS_READONLY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
export const GMAIL_METADATA_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export interface GoogleWorkspaceAuthConfig {
  projectId: string;
  serviceAccountEmail: string;
  serviceAccountPrivateKey: string;
  adminDelegatedUser: string;
}

export interface GoogleJwtOptions {
  email: string;
  key: string;
  scopes: readonly string[];
  subject: string;
}

export interface GoogleDirectoryUsersClient {
  list(params: {
    customer: string;
    maxResults: number;
    orderBy: string;
    projection: string;
    pageToken?: string;
  }): Promise<{ data: { users?: { primaryEmail?: string; suspended?: boolean; archived?: boolean }[]; nextPageToken?: string } }>;
}

export type GmailMessageFormat = 'metadata' | 'full';

export interface GoogleGmailClient {
  users: {
    getProfile(params: {
      userId: 'me';
    }): Promise<{ data: { emailAddress?: string; messagesTotal?: number; threadsTotal?: number; historyId?: string } }>;
    history: {
      list(params: {
        userId: 'me';
        startHistoryId: string;
        maxResults?: number;
        pageToken?: string;
      }): Promise<{ data: { history?: { id?: string; messagesAdded?: { message?: { id?: string; threadId?: string } }[]; messagesDeleted?: { message?: { id?: string; threadId?: string } }[]; labelsAdded?: { message?: { id?: string; threadId?: string }; labelIds?: string[] }[]; labelsRemoved?: { message?: { id?: string; threadId?: string }; labelIds?: string[] }[] }[]; historyId?: string; nextPageToken?: string } }>;
    };
    messages: {
      list(params: {
        userId: 'me';
        maxResults: number;
        includeSpamTrash: false;
        labelIds?: string[];
        pageToken?: string;
      }): Promise<{ data: { messages?: { id?: string; threadId?: string }[]; nextPageToken?: string } }>;
      get(params: {
        userId: 'me';
        id: string;
        format: GmailMessageFormat;
      }): Promise<{ data: unknown }>;
    };
  };
}
export interface GoogleAuthFactory {
  createJwt(options: GoogleJwtOptions): object;
  createAdminClient(auth: object): GoogleDirectoryUsersClient;
  createGmailClient(auth: object): GoogleGmailClient;
}

const defaultFactory: GoogleAuthFactory = {
  createJwt: (options) => new google.auth.JWT({
    email: options.email,
    key: options.key,
    scopes: [...options.scopes],
    subject: options.subject,
  }),
  createAdminClient: (auth) => google.admin({ version: 'directory_v1', auth: auth as never }).users as unknown as GoogleDirectoryUsersClient,
  createGmailClient: (auth) => google.gmail({ version: 'v1', auth: auth as never }) as unknown as GoogleGmailClient,
};

export interface GmailAuthorizationContext {
  client: GoogleGmailClient;
  mailbox: GmailMailboxConfig;
  subject: string;
  scope: typeof GMAIL_METADATA_SCOPE | typeof GMAIL_READONLY_SCOPE;
}

export class GoogleWorkspaceAuthService {
  public constructor(
    private readonly config: GoogleWorkspaceAuthConfig,
    private readonly factory: GoogleAuthFactory = defaultFactory,
  ) {}

  public getAdminDirectoryClient(): GoogleDirectoryUsersClient {
    const auth = this.createJwt(this.config.adminDelegatedUser, [GOOGLE_ADMIN_DIRECTORY_USERS_READONLY_SCOPE]);
    return this.factory.createAdminClient(auth);
  }

  public getGmailAuthorization(mailboxAddress: string): GmailAuthorizationContext {
    const mailbox = resolveGmailMailboxPolicy(mailboxAddress);
    const scope = this.scopeFor(mailbox.contentMode);
    const auth = this.createJwt(mailbox.normalizedAddress, [scope]);
    return {
      client: this.factory.createGmailClient(auth),
      mailbox,
      subject: mailbox.normalizedAddress,
      scope,
    };
  }

  private scopeFor(contentMode: GmailContentMode): typeof GMAIL_METADATA_SCOPE | typeof GMAIL_READONLY_SCOPE {
    return contentMode === 'CONTENT' ? GMAIL_READONLY_SCOPE : GMAIL_METADATA_SCOPE;
  }

  private createJwt(subject: string, scopes: readonly string[]): object {
    if (!this.config.serviceAccountEmail.trim() || !this.config.serviceAccountPrivateKey.trim()) {
      throw new Error('Google service-account credentials are not configured.');
    }
    if (!subject.trim()) throw new Error('Google delegated subject is not configured.');
    return this.factory.createJwt({
      email: this.config.serviceAccountEmail,
      key: this.config.serviceAccountPrivateKey,
      scopes,
      subject,
    });
  }
}

export const googleWorkspaceAuthService = new GoogleWorkspaceAuthService({
  projectId: env.GOOGLE_CLOUD_PROJECT_ID,
  serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  serviceAccountPrivateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  adminDelegatedUser: env.GOOGLE_ADMIN_DELEGATED_USER,
});
