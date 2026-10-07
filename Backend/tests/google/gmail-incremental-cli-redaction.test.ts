import { describe, it, expect } from '@jest/globals';
import { redact, causeStatus } from '../../src/scripts/gmail-sync-diagnostics';

describe('gmail sync diagnostics', () => {
  it('redacts JWTs, bearer tokens, private keys, long tokens and URLs', () => {
    const out = redact('Bearer abc.def eyJhbGciOi.eyJzdWIiOi.sig123 -----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY----- https://x.test/a?t=1 ' + 'A'.repeat(50));
    expect(out).not.toMatch(/abc\.def|eyJ|MII|x\.test|AAAAAAAAAA/);
  });

  it('extracts HTTP status from a cause', () => {
    expect(causeStatus({ response: { status: 403 } })).toBe('403');
    expect(causeStatus(new Error('x'))).toBe('unknown');
  });
});
