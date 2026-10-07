import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeMailboxAddress,
  resolveGmailMailboxPolicy,
  sanitizeApprovedMailboxAllowlist,
} from '../../src/modules/google/gmail-policy';

describe('Gmail mailbox privacy policy', () => {
  it.each([
    [' service@trufinity.ca ', 'service@trufinity.ca'],
    ['SUPPORT@TRUFINITY.CA', 'support@trufinity.ca'],
    ['billing@trufinity.ca', 'billing@trufinity.ca'],
  ])('normalizes approved mailbox %s', (input, expected) => {
    expect(normalizeMailboxAddress(input)).toBe(expected);
    expect(resolveGmailMailboxPolicy(input).contentMode).toBe('CONTENT');
  });

  it('uses metadata mode for every other mailbox', () => {
    expect(resolveGmailMailboxPolicy('finance@trufinity.ca')).toMatchObject({
      normalizedAddress: 'finance@trufinity.ca',
      contentMode: 'METADATA',
      includeFolders: ['INBOX', 'SENT'],
      excludeFolders: ['DRAFT', 'SPAM', 'TRASH'],
      storeAttachmentBinary: false,
    });
  });

  it('does not allow casing, whitespace, invalid input, or a caller mode to elevate access', () => {
    expect(resolveGmailMailboxPolicy(' Finance@TruFinity.ca ').contentMode).toBe('METADATA');
    expect(normalizeMailboxAddress('finance@trufinity.ca\r\nBcc: attacker@example.com')).toBeNull();
    expect(() => resolveGmailMailboxPolicy('not-an-email')).toThrow();
  });

  it('rejects an allowlist that broadens the locked policy', () => {
    expect(sanitizeApprovedMailboxAllowlist('service@trufinity.ca,support@trufinity.ca,billing@trufinity.ca')).toHaveLength(3);
    expect(() => sanitizeApprovedMailboxAllowlist('service@trufinity.ca,finance@trufinity.ca,billing@trufinity.ca')).toThrow();
    expect(() => sanitizeApprovedMailboxAllowlist('service@trufinity.ca,support@trufinity.ca')).toThrow();
  });

  it('keeps folders and attachment policy fixed', () => {
    const policy = resolveGmailMailboxPolicy('service@trufinity.ca');
    expect(policy.includeFolders).toEqual(['INBOX', 'SENT']);
    expect(policy.excludeFolders).toEqual(['DRAFT', 'SPAM', 'TRASH']);
    expect(policy.storeAttachmentBinary).toBe(false);
  });
});

describe('Gmail foundation migration', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '../../migrations/20260922090000_009_google_gmail_foundation.ts'),
    'utf8',
  );

  it('defines content-mode protection and latest-message uniqueness', () => {
    expect(migration).toContain("content_mode IN ('METADATA', 'CONTENT')");
    expect(migration).toContain('idx_raw_gmail_messages_latest');
    expect(migration).toContain('normalized_mailbox_address');
  });

  it('has no attachment binary/blob persistence field', () => {
    expect(migration).not.toMatch(/attachment|blob|bytea/i);
  });
});
