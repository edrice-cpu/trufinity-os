import type { Knex } from 'knex';
import { logger } from './logger';

// A Postgres session-level advisory lock, scoped to a string key, used to
// prevent duplicate concurrent execution of a scheduled job across multiple
// app instances/workers (the lock lives in Postgres, not in process memory,
// so it works regardless of how many processes are running the scheduler).
// Shared by every raw-ingestion module (Lace, ServiceTitan, ...) instead of
// each reimplementing the acquire/release/connection-teardown dance.
export async function withAdvisoryLock<T>(
  database: Knex,
  lockKey: string,
  onLockUnavailable: () => Error,
  work: () => Promise<T>,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const connection = await database.client.acquireConnection();
  let acquired = false;
  let connectionShouldBeDestroyed = false;
  try {
    const result: unknown = await database.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', [lockKey]).connection(connection);
    const rows = typeof result === 'object' && result !== null && 'rows' in result ? (result as { rows?: unknown }).rows : null;
    acquired = Array.isArray(rows) && rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null && (rows[0] as { locked?: unknown }).locked === true;
    if (!acquired) throw onLockUnavailable();
    return await work();
  } finally {
    try {
      if (acquired) {
        await database.raw('SELECT pg_advisory_unlock(hashtext(?))', [lockKey]).connection(connection);
      }
    } catch {
      connectionShouldBeDestroyed = true;
      logger.error(`Advisory lock release failed for key "${lockKey}"; closing lock connection.`);
    } finally {
      if (connectionShouldBeDestroyed) {
        // A failed unlock may leave a session-level lock behind. Destroy the
        // physical connection before returning it to the pool.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await database.client.destroyRawConnection(connection).catch(() => undefined);
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await database.client.releaseConnection(connection);
    }
  }
}
