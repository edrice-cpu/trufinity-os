import { db } from '../database';
import { gmailIncrementalSyncService } from '../modules/google/gmail-incremental.service';
import { redact, causeStatus } from './gmail-sync-diagnostics';

function parseOptions(args: string[]): string {
  if (args.length === 1 && args[0].trim() !== '') {
    return args[0].trim();
  }
  throw new Error('Usage: npm run google:gmail-incremental-sync -- <mailbox>');
}

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    (global as any).__GMAIL_SYNC_STAGE = 'CLI argument validation';
    const mailboxAddress = parseOptions(process.argv.slice(2));
    const result = await gmailIncrementalSyncService.runMailbox(mailboxAddress);
    console.log(`${result.mailboxAddress} | ${result.contentMode} | COMPLETED | processed=${result.recordsProcessed} | persisted=${result.recordsPersisted}`);
  } catch (error) {
    const stage = (global as any).__GMAIL_SYNC_STAGE || 'unknown stage';
    let statusCode = 'unknown';
    if (typeof error === 'object' && error !== null && 'response' in error) {
      const response = (error as any).response;
      if (response && typeof response.status === 'number') {
        statusCode = response.status.toString();
      }
    }
    
    console.error('--- GMAIL INCREMENTAL SYNC DIAGNOSTIC ERROR ---');
    console.error(`Stage: ${stage}`);
    console.error(`Error Name: ${error instanceof Error ? error.name : 'Unknown Error'}`);
    console.error(`HTTP Status: ${statusCode}`);
    
    const safeMsg = redact(error instanceof Error ? error.message : 'Unknown error');
    console.error(`Message: ${safeMsg}`);

    // The service wraps failures in a generic SAFE_FAILURE error; surface only
    // the underlying cause's name, HTTP status and redacted message.
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
    if (cause !== undefined && cause !== null) {
      console.error(`Cause Name: ${cause instanceof Error ? cause.name : typeof cause}`);
      console.error(`Cause HTTP Status: ${causeStatus(cause)}`);
      console.error(`Cause Message: ${redact(cause instanceof Error ? cause.message : 'Non-Error cause')}`);
    }
    
    exitCode = 1;
  } finally {
    await db.destroy();
  }
  process.exitCode = exitCode;
}

void main();
