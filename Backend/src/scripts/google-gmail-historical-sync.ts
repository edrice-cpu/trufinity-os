import { db } from '../database';
import { gmailHistoricalSyncService } from '../modules/google/gmail-historical.service';

interface RunnerOptions {
  mailboxAddress: string | null;
  allEligible: boolean;
}

function parseOptions(args: string[]): RunnerOptions {
  if (args.length === 2 && args[0] === '--mailbox' && args[1].trim() !== '') return { mailboxAddress: args[1], allEligible: false };
  if (args.length === 1 && args[0] === '--all') return { mailboxAddress: null, allEligible: true };
  throw new Error('Usage: npm run google:gmail-historical-sync -- --mailbox <mailbox> | --all');
}

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    (global as any).__GMAIL_SYNC_STAGE = 'CLI argument validation';
    const options = parseOptions(process.argv.slice(2));
    if (options.mailboxAddress) {
      const result = await gmailHistoricalSyncService.runMailbox(options.mailboxAddress);
      console.log(`${result.mailboxAddress} | ${result.contentMode} | COMPLETED | processed=${result.recordsProcessed} | persisted=${result.recordsPersisted}`);
    } else if (options.allEligible) {
      const result = await gmailHistoricalSyncService.runAllEligibleMailboxes();
      for (const completed of result.completed) {
        console.log(`${completed.mailboxAddress} | ${completed.contentMode} | COMPLETED | processed=${completed.recordsProcessed} | persisted=${completed.recordsPersisted}`);
      }
      for (const failed of result.failed) console.log(`${failed.mailboxAddress} | FAILED`);
      if (result.failed.length > 0) exitCode = 1;
    }
  } catch (error) {
    const stage = (global as any).__GMAIL_SYNC_STAGE || 'unknown stage';
    let statusCode = 'unknown';
    if (typeof error === 'object' && error !== null && 'response' in error) {
      const response = (error as any).response;
      if (response && typeof response.status === 'number') {
        statusCode = response.status.toString();
      }
    }

    console.error('--- GMAIL HISTORICAL SYNC DIAGNOSTIC ERROR ---');
    console.error(`Stage: ${stage}`);
    console.error(`Error Name: ${error instanceof Error ? error.name : 'Unknown Error'}`);
    console.error(`HTTP Status: ${statusCode}`);

    let safeMsg = error instanceof Error ? error.message : 'Unknown error';
    safeMsg = safeMsg.replace(/(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/g, '[REDACTED_JWT]');
    safeMsg = safeMsg.replace(/([a-zA-Z0-9-_]{40,})/g, '[REDACTED_TOKEN]');
    safeMsg = safeMsg.replace(/(https?:\/\/[^\s]+)/g, '[REDACTED_URL]');
    console.error(`Message: ${safeMsg}`);

    exitCode = 1;
  } finally {
    await db.destroy();
  }
  process.exitCode = exitCode;
}

void main();