import { describe, expect, it } from '@jest/globals';

// Standing regression guard for a real incident: a test run once connected
// to the live production database (DB_NAME without a "_test" suffix) and
// wrote mock narrative text onto real detected_alerts rows, because the
// run never set NODE_ENV=test in the first place - see the hard guard this
// asserts in src/config/env.ts, and tests/jest.setup-env.js which is
// supposed to force this before any test file's own imports run.
//
// This file deliberately re-imports env fresh (via a dynamic import inside
// the test, after asserting the raw process.env state) so it reports the
// actual values this process is running with, not a cached module from
// another test file.
describe('Test database isolation (regression guard)', () => {
  it('is running under NODE_ENV=test or an equivalent Jest-detected context', () => {
    const isTestRuntime = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
    expect(isTestRuntime).toBe(true);
  });

  it('never allows DB_NAME to be a database without a "_test" suffix in this process', async () => {
    const { env } = await import('../src/config/env');
    expect(env.DB_NAME.endsWith('_test')).toBe(true);
  });

  it('is not pointed at a database literally named after the production database', async () => {
    const { env } = await import('../src/config/env');
    // Belt-and-suspenders: even if a future DB_NAME happened to end in
    // "_test" by coincidence, it must not be exactly the known-production name.
    expect(env.DB_NAME).not.toBe('trufinity');
    expect(env.DB_NAME).not.toBe('trufinity_prod');
  });
});
