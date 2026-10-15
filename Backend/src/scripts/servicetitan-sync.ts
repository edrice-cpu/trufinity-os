import { parseArgs } from 'node:util';
import { db } from '../database';
import { runMissedServiceTitanSyncs } from '../modules/servicetitan/servicetitan.scheduler';

// Runs the ServiceTitan raw syncs now, the same way the scheduler does.
// By default only entities whose last successful sync is overdue; --all runs
// every entity. One entity at a time (API rate limits); safe to re-run.
//
//   npm run servicetitan:sync            # catch up overdue entities
//   npm run servicetitan:sync -- --all   # sync everything now
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { all: { type: 'boolean' } } });
  const ran = await runMissedServiceTitanSyncs({ force: values.all === true });
  console.log(ran.length === 0 ? 'Every ServiceTitan entity is up to date - nothing to sync.' : `Ran: ${ran.join(', ')}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'ServiceTitan sync failed.');
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
