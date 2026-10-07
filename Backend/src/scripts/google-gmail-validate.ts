import { db } from '../database';
import { env } from '../config/env';
import { googleWorkspaceAuthService, GMAIL_METADATA_SCOPE } from '../modules/google/google-auth.service';
import { resolveGmailMailboxPolicy } from '../modules/google/gmail-policy';
import { buildMetadataPayload, normalizeMessage, withRetry } from '../modules/google/gmail-historical.service';
import { gmailHistoricalRepository, type GmailHistoricalMailbox, type GmailHistoricalMessageWrite } from '../modules/google/gmail-historical.repository';

export const VALIDATION_CAP = 5;
export async function validateSample(address: string, replayIds?: string[], dependencies = {
  auth: googleWorkspaceAuthService,
  repository: gmailHistoricalRepository,
  database: db,
  classifierEnabled: env.GMAIL_CLASSIFIER_ENABLED,
}) {
  const policy = resolveGmailMailboxPolicy(address);
  if (policy.contentMode !== 'METADATA' || !policy.normalizedAddress.endsWith('@trufinity.ca')) throw new Error('Validation requires a Trufinity METADATA mailbox.');
  if (dependencies.classifierEnabled) throw new Error('Disable the classifier before validation.');
  if (replayIds && (replayIds.length === 0 || replayIds.length > VALIDATION_CAP || replayIds.some(id => !/^[a-f0-9]+$/i.test(id)) || new Set(replayIds).size !== replayIds.length)) throw new Error('Replay requires one to five unique Gmail IDs.');
  const authorization = dependencies.auth.getGmailAuthorization(policy.normalizedAddress);
  if (authorization.scope !== GMAIL_METADATA_SCOPE || authorization.subject !== policy.normalizedAddress) throw new Error('Validation authorization mismatch.');
  return dependencies.repository.withMailboxLock(policy.normalizedAddress, async () => {
    // Require existing registration: never enable/update a mailbox or its checkpoints.
    const row = await dependencies.database('google_gmail_mailboxes').where({ normalized_mailbox_address: policy.normalizedAddress, content_mode: 'METADATA', account_type: 'USER' }).first();
    if (!row) throw new Error('Validation requires an existing METADATA user mailbox registration.');
    const mailbox: GmailHistoricalMailbox = { id: row.id, mailboxAddress: row.mailbox_address, normalizedMailboxAddress: row.normalized_mailbox_address, contentMode: 'METADATA' };
    let ids = replayIds;
    if (!ids) {
      // One bounded page per folder; no q search (unsupported by gmail.metadata).
      const candidates = new Set<string>();
      for (const label of ['INBOX', 'SENT']) {
        const response = await withRetry(() => authorization.client.users.messages.list({ userId: 'me', maxResults: VALIDATION_CAP, includeSpamTrash: false, labelIds: [label] }));
        for (const message of response.data.messages ?? []) if (message.id && candidates.size < VALIDATION_CAP) candidates.add(message.id);
        if (candidates.size === VALIDATION_CAP) break;
      }
      ids = [...candidates];
    }
    const writes: GmailHistoricalMessageWrite[] = [];
    for (const id of ids.slice(0, VALIDATION_CAP)) {
      const response = await withRetry(() => authorization.client.users.messages.get({ userId: 'me', id, format: 'metadata' }));
      const message = normalizeMessage(response.data);
      if (!message || message.id !== id) throw new Error('Invalid validation metadata response.');
      if (message.labelIds.some(label => ['DRAFT', 'SPAM', 'TRASH'].includes(label)) || !message.labelIds.some(label => ['INBOX', 'SENT'].includes(label))) throw new Error('Validation message is outside Inbox/Sent scope.');
      writes.push({ providerMessageId: id, threadId: message.threadId, payload: buildMetadataPayload(message), contentMode: 'METADATA', internalDate: message.internalDate, providerHistoryId: message.historyId });
    }
    if (writes.length === 0) return { mailbox: policy.normalizedAddress, ids, processed: 0, persisted: 0, runId: null };
    const runId = await dependencies.repository.createSyncRun(`GmailValidation:${policy.normalizedAddress}`);
    try {
      const persisted = await dependencies.repository.commitBatch(mailbox, runId, writes, []);
      // Complete this validation run only. Never use normal sync completion methods.
      await dependencies.database('sync_runs').where({ id: runId, entity_type: `GmailValidation:${policy.normalizedAddress}`, status: 'RUNNING' }).update({ status: 'COMPLETED', records_processed: writes.length, completed_at: dependencies.database.fn.now() });
      return { mailbox: policy.normalizedAddress, ids, processed: writes.length, persisted, runId };
    } catch {
      await dependencies.repository.failSyncRun(runId, 0, 'Gmail metadata validation persistence failed.');
      throw new Error('Gmail metadata validation persistence failed.');
    }
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valid = args.length === 2 && args[0] === '--mailbox' || args.length === 4 && args[0] === '--mailbox' && args[2] === '--ids';
  void (async () => {
    try {
      if (!valid) throw new Error('Invalid validation arguments.');
      console.log(JSON.stringify(await validateSample(args[1], args.length === 4 ? args[3].split(',') : undefined)));
    } catch { console.error('Bounded Gmail metadata validation failed; no normal checkpoint advancement.'); process.exitCode = 1; }
    finally { await db.destroy(); }
  })();
}
