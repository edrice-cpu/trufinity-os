import { GMAIL_APPROVED_CONTENT_MAILBOXES, type GmailMailboxConfig } from './types';

const APPROVED = new Set<string>(GMAIL_APPROVED_CONTENT_MAILBOXES);

export const normalizeMailboxAddress = (value: string): string | null => {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) return null;
  return normalized;
};

export const isApprovedContentMailbox = (address: string): boolean => {
  const normalized = normalizeMailboxAddress(address);
  return normalized !== null && APPROVED.has(normalized);
};

/** Content mode is derived only from the normalized mailbox address. */
export const resolveGmailMailboxPolicy = (address: string): GmailMailboxConfig => {
  const normalizedAddress = normalizeMailboxAddress(address);
  if (normalizedAddress === null) throw new Error('Invalid Gmail mailbox address.');
  return {
    address: address.trim(),
    normalizedAddress,
    contentMode: isApprovedContentMailbox(normalizedAddress) ? 'CONTENT' : 'METADATA',
    includeFolders: ['INBOX', 'SENT'],
    excludeFolders: ['DRAFT', 'SPAM', 'TRASH'],
    storeAttachmentBinary: false,
  };
};

export const sanitizeApprovedMailboxAllowlist = (configured: string): readonly string[] => {
  const values = configured.split(',').map(normalizeMailboxAddress).filter((value): value is string => value !== null);
  const unique = [...new Set(values)];
  if (unique.length !== GMAIL_APPROVED_CONTENT_MAILBOXES.length || unique.some((value) => !APPROVED.has(value))) {
    throw new Error('Google Gmail approved content mailbox configuration cannot broaden the locked policy.');
  }
  return GMAIL_APPROVED_CONTENT_MAILBOXES;
};
