import type { Knex } from 'knex';
import { env } from '../config/env';

const config: Record<string, Knex.Config> = {
  development: {
    client: 'pg',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
    },
    migrations: {
      directory: '../../migrations',
      extension: 'ts',
    },
  },
  // Same shape as development - only env.DB_NAME differs, and that's already
  // forced onto an isolated "..._test" database before this file loads (see
  // tests/jest.setup-env.js and the guard in src/config/env.ts). Listed
  // explicitly rather than relying on the `|| knexConfig.development`
  // fallback in src/database/index.ts, so the test path is visible here too.
  test: {
    client: 'pg',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
    },
    migrations: {
      directory: '../../migrations',
      extension: 'ts',
    },
  },
  production: {
    client: 'pg',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      ssl: { rejectUnauthorized: false }, // Useful for managed DBs
    },
    migrations: {
      directory: '../../migrations',
      extension: 'ts',
    },
  },
};

export default config;
