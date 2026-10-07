import knex from 'knex';
import knexConfig from './knexfile';
import { env } from '../config/env';

export const db = knex(knexConfig[env.NODE_ENV] || knexConfig.development);
