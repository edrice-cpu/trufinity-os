// Forces every test run onto an isolated database, before src/config/env.ts
// (and therefore src/database/knexfile.ts, src/database/index.ts) is ever
// imported by a test file.
//
// Dual-purpose: referenced from jest.config.js's `setupFiles` (runs once per
// test file, before that file's own imports), and usable as a plain Node
// `-r` preload for one-off scripts that need the same override outside Jest
// (see package.json's "test:migrate"). Kept as plain CommonJS - no ts-jest
// transform step required either way.
//
// One-time setup required before running tests or test:migrate:
//   createdb trufinity_test
// (same DB_HOST/DB_USER/DB_PASSWORD as .env - only the database name differs.)
//
// Optional: copy .env.test.example to .env.test to override DB_NAME (must
// end in "_test") or any other variable for the test run. Never commit real
// credentials in .env.test.
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env.test') });

process.env.NODE_ENV = 'test';
// Guaranteed fallback even if .env.test doesn't exist or doesn't set DB_NAME.
if (!process.env.DB_NAME || !process.env.DB_NAME.endsWith('_test')) {
  process.env.DB_NAME = 'trufinity_test';
}
