import {
  googleWorkspaceAuthService,
  type GmailAuthorizationContext,
} from './google-auth.service';
import {
  gmailHistoricalRepository,
  type GmailHistoricalMessageWrite,
  type GmailHistoricalMailbox,
  type GmailHistoricalError,
} from './gmail-historical.repository';
import {
  isEligibleGmailSynchronizationMailbox,
  googleWorkspaceDirectoryService,
} from './workspace-directory.service';
import {
  INCLUDED_LABELS,
  EXCLUDED_LABELS,
  PAGE_SIZE,
  SAFE_FAILURE,
  safeErrorMessage,
  withRetry,
  hasLockedAuthorization,
  normalizeMessage,
  buildMetadataPayload,
  buildContentPayload,
  type GmailHistoricalSyncResult,
  type GmailHistoricalMailboxFailure,
  type GmailHistoricalAllResult,
  gmailHistoricalSyncService,
} from './gmail-historical.service';
import { gmailClassificationHook, type GmailClassificationHook } from './gmail-classification.service';
import type { ClassificationPersistenceInput } from './classification.repository';

export class GmailIncrementalSyncService {
  public constructor(
    private readonly authService = googleWorkspaceAuthService,
    private readonly directoryService = googleWorkspaceDirectoryService,
    private readonly repository = gmailHistoricalRepository,
    private readonly historicalService = gmailHistoricalSyncService,
    private readonly classificationHook: GmailClassificationHook = gmailClassificationHook,
  ) {}

  public async runMailbox(mailboxAddress: string): Promise<GmailHistoricalSyncResult> {
    (global as any).__GMAIL_SYNC_STAGE = 'incremental authorization/discovery';
    const mailboxes = await this.directoryService.discoverActiveMailboxes();
    const isDiscovered = mailboxes.some((m) => m.normalizedAddress === mailboxAddress.toLowerCase().trim());
    if (!isDiscovered) throw new Error('Mailbox is not eligible, suspended, archived, or not found in Google Workspace directory.');

    const authorization = this.authService.getGmailAuthorization(mailboxAddress);
    if (!isEligibleGmailSynchronizationMailbox(authorization.mailbox) || !hasLockedAuthorization(authorization)) {
      throw new Error('Google Workspace Gmail incremental synchronization requires a correctly authorized eligible mailbox.');
    }

    try {
      return await this.repository.withMailboxLock(authorization.mailbox.normalizedAddress, async () => this.runLocked(authorization));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GMAIL_HISTORY_404_INITIAL:')) {
        const timestamp = parseInt(error.message.split(':')[1], 10);
        if (Number.isFinite(timestamp)) {
          return this.historicalService.runMailbox(mailboxAddress, new Date(timestamp));
        }
      }
      if (error instanceof Error && error.message === 'GMAIL_HISTORY_404_EXPIRED') {
        // Fallback to historical sync without holding the lock (full 365 days as per EXPIRED fallback rules)
        return this.historicalService.runMailbox(mailboxAddress);
      }
      throw error;
    }
  }

  public async runAllEligibleMailboxes(): Promise<GmailHistoricalAllResult> {
    const completed: GmailHistoricalSyncResult[] = [];
    const failed: GmailHistoricalMailboxFailure[] = [];
    const mailboxes = await this.directoryService.discoverActiveMailboxes();
    for (const mailbox of mailboxes) {
      try { completed.push(await this.runMailbox(mailbox.normalizedAddress)); }
      catch (error) { failed.push({ mailboxAddress: mailbox.normalizedAddress, safeMessage: safeErrorMessage(error) }); }
    }
    return { completed, failed };
  }

  private async runLocked(authorization: GmailAuthorizationContext): Promise<GmailHistoricalSyncResult> {
    const entityType = `GmailIncremental:${authorization.mailbox.normalizedAddress}`;
    await this.repository.recoverInterruptedRun(entityType);
    const mailbox = await this.repository.ensureMailbox(authorization.mailbox);
    
    (global as any).__GMAIL_SYNC_STAGE = 'initial-checkpoint detection';
    const metadata = await this.repository.getSyncMetadata(mailbox.id);
    const startHistoryId = metadata.historyId;

    if (!startHistoryId) {
      if (metadata.lastSuccessfulSyncAt) {
        throw new Error(`GMAIL_HISTORY_404_INITIAL:${metadata.lastSuccessfulSyncAt.getTime()}`);
      }
      throw new Error('GMAIL_HISTORY_404_EXPIRED');
    }

    let syncRunId: string | null = null;
    let processed = 0;
    try {
      (global as any).__GMAIL_SYNC_STAGE = 'sync-run creation';
      syncRunId = await this.repository.createSyncRun(entityType);
      
      const result = await this.syncHistory(authorization, mailbox, syncRunId, startHistoryId);
      processed = result.processed;

      // Advance the checkpoint and finalize this sync_runs row as COMPLETED
      // atomically: both happen only after all History API pages have been
      // persisted above, and either both land or neither does.
      (global as any).__GMAIL_SYNC_STAGE = 'checkpoint completion';
      await this.repository.completeIncrementalRun(mailbox.id, syncRunId, result.newHistoryId, processed);

      return { mailboxAddress: mailbox.normalizedMailboxAddress, contentMode: authorization.mailbox.contentMode, syncRunId, recordsProcessed: processed, recordsPersisted: result.persisted };
    } catch (error) {
      if (syncRunId) await this.repository.failSyncRun(syncRunId, processed, safeErrorMessage(error));
      
      const err = error as Record<string, unknown> | null;
      if (err && typeof err === 'object' && err.response && typeof err.response === 'object' && (err.response as Record<string, unknown>).status === 404) {
         throw new Error('GMAIL_HISTORY_404_EXPIRED', { cause: error });
      }
      
      throw new Error(SAFE_FAILURE, { cause: error });
    }
  }

  private async syncHistory(
    authorization: GmailAuthorizationContext,
    mailbox: GmailHistoricalMailbox,
    syncRunId: string,
    startHistoryId: string,
  ): Promise<{ processed: number; persisted: number; newHistoryId: string | null }> {
    let pageToken: string | undefined;
    let stop = false;
    let processed = 0;
    let persisted = 0;
    let newHistoryId: string | null = null;

    while (!stop) {
      (global as any).__GMAIL_SYNC_STAGE = 'history.list';
      const listed = await withRetry(async () => authorization.client.users.history.list({
        userId: 'me', startHistoryId, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}),
      }));

      if (listed.data.historyId && !newHistoryId) {
        newHistoryId = String(listed.data.historyId);
      }

      const writes: GmailHistoricalMessageWrite[] = [];
      const classifications: ClassificationPersistenceInput[] = [];
      const errors: GmailHistoricalError[] = [];
      
      const toFetch = new Set<string>();
      const toDelete = new Set<string>();

      for (const historyRecord of listed.data.history ?? []) {
        if (historyRecord.messagesAdded) {
          for (const msg of historyRecord.messagesAdded) {
            if (msg.message?.id) toFetch.add(msg.message.id);
          }
        }
        if (historyRecord.labelsAdded) {
          for (const msg of historyRecord.labelsAdded) {
            if (msg.message?.id) toFetch.add(msg.message.id);
          }
        }
        if (historyRecord.messagesDeleted) {
          for (const msg of historyRecord.messagesDeleted) {
            if (msg.message?.id) toDelete.add(msg.message.id);
          }
        }
        if (historyRecord.labelsRemoved) {
          for (const msg of historyRecord.labelsRemoved) {
            if (msg.message?.id) {
               toFetch.add(msg.message.id);
            }
          }
        }
      }

      for (const msgId of toDelete) {
        toFetch.delete(msgId);
        writes.push({
          providerMessageId: msgId,
          threadId: '', 
          payload: null,
          contentMode: authorization.mailbox.contentMode,
          internalDate: new Date(),
          providerHistoryId: null,
          isDeleted: true,
        });
      }

      (global as any).__GMAIL_SYNC_STAGE = 'message fetch';
      for (const msgId of toFetch) {
        try {
          const raw = await withRetry(async () => authorization.client.users.messages.get({
            userId: 'me', id: msgId, format: authorization.mailbox.contentMode === 'METADATA' ? 'metadata' : 'full',
          }));
          const message = normalizeMessage(raw.data);
          if (!message) {
            errors.push({ sourceId: msgId, message: 'Gmail message response was malformed.' });
            continue;
          }
          
          const inScope = message.labelIds.some(label => (INCLUDED_LABELS as readonly string[]).includes(label)) && 
                          !message.labelIds.some(label => EXCLUDED_LABELS.has(label));
                          
          if (inScope) {
            const classification = authorization.mailbox.contentMode === 'CONTENT'
              ? await this.classificationHook.classifyMessage(authorization, message, mailbox.id)
              : null;
            if (classification) classifications.push(classification);
            writes.push({
              providerMessageId: message.id,
              threadId: message.threadId,
              payload: authorization.mailbox.contentMode === 'METADATA' ? buildMetadataPayload(message) : buildContentPayload(message),
              contentMode: authorization.mailbox.contentMode,
              internalDate: message.internalDate,
              providerHistoryId: message.historyId,
              isDeleted: false,
            });
          } else {
            writes.push({
              providerMessageId: message.id,
              threadId: message.threadId,
              payload: null,
              contentMode: authorization.mailbox.contentMode,
              internalDate: message.internalDate,
              providerHistoryId: message.historyId,
              isDeleted: true,
            });
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Email classifier')) throw error;
          const err = error as Record<string, unknown> | null;
          if (err && typeof err === 'object' && err.response && typeof err.response === 'object' && (err.response as Record<string, unknown>).status === 404) {
             writes.push({
               providerMessageId: msgId,
               threadId: '',
               payload: null,
               contentMode: authorization.mailbox.contentMode,
               internalDate: new Date(),
               providerHistoryId: null,
               isDeleted: true,
             });
          } else {
             errors.push({ sourceId: msgId, message: safeErrorMessage(error) });
          }
        }
      }

      (global as any).__GMAIL_SYNC_STAGE = 'batch commit';
      if (errors.length > 0) {
        // Persist only sanitized diagnostics for an incomplete page. Keep the
        // previous checkpoint and replay all pages on the next run; previously
        // committed pages use the repository's identical-payload deduplication.
        await this.repository.commitBatch(mailbox, syncRunId, [], errors);
        throw new Error(SAFE_FAILURE);
      }
      persisted += classifications.length > 0 ? await this.repository.commitBatch(mailbox, syncRunId, writes, errors, classifications) : await this.repository.commitBatch(mailbox, syncRunId, writes, errors);
      processed += writes.length;
      
      pageToken = listed.data.nextPageToken;
      if (!pageToken) stop = true;
    }
    
    return { processed, persisted, newHistoryId };
  }
}

export const gmailIncrementalSyncService = new GmailIncrementalSyncService();
