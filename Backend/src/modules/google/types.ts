export const GMAIL_APPROVED_CONTENT_MAILBOXES = [
  'service@trufinity.ca',
  'support@trufinity.ca',
  'billing@trufinity.ca',
] as const;

export type GmailContentMode = 'METADATA' | 'CONTENT';

export interface GmailMailboxConfig {
  address: string;
  normalizedAddress: string;
  contentMode: GmailContentMode;
  includeFolders: readonly ['INBOX', 'SENT'];
  excludeFolders: readonly ['DRAFT', 'SPAM', 'TRASH'];
  storeAttachmentBinary: false;
}

export interface GmailMessageRecord {
  mailboxId: string;
  mailboxAddress: string;
  providerMessageId: string;
  threadId: string;
  payload: Record<string, unknown>;
  contentMode: GmailContentMode;
  internalDate: string | null;
  providerHistoryId: string | null;
  isDeleted: boolean;
}

export interface GmailSyncCheckpoint {
  mailboxId: string;
  historicalPageToken: string | null;
  historyId: string | null;
  lastSuccessfulHistoryId: string | null;
  lastSuccessfulSyncAt: string | null;
}
