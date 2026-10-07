/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
  // Must run before any test file imports src/config/env.ts, so DB_NAME is
  // already forced onto the isolated test database by the time env.ts loads
  // .env - see tests/jest.setup-env.js.
  setupFiles: ['<rootDir>/tests/jest.setup-env.js'],
  // The default 5000ms is occasionally too tight for this DB connection's
  // round-trip latency (observed intermittently against the local test
  // database - advisory-lock acquisition plus several sequential queries per
  // test can exceed it under load). Bumping the global default avoids each
  // new DB-touching test file needing its own jest.setTimeout() call.
  testTimeout: 30000,
};
