import { env } from '../../config/env';
import {
  GMAIL_METADATA_SCOPE,
  GMAIL_READONLY_SCOPE,
  googleWorkspaceAuthService,
  type GmailAuthorizationContext,
} from './google-auth.service';
import { gmailHistoricalRepository, type GmailHistoricalError, type GmailHistoricalMailbox, type GmailHistoricalMessageWrite, type GmailHistoricalRepository } from './gmail-historical.repository';
import { isEligibleGmailSynchronizationMailbox, googleWorkspaceDirectoryService } from './workspace-directory.service';
import type { GmailContentMode } from './types';
import { gmailClassificationHook, type GmailClassificationHook } from './gmail-classification.service';
import type { ClassificationPersistenceInput } from './classification.repository';

export const INCLUDED_LABELS = ['INBOX', 'SENT'] as const;
export const EXCLUDED_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH']);
export const MAX_ATTEMPTS = 3;
export const PAGE_SIZE = 100;
export const SAFE_FAILURE = 'Google Workspace Gmail historical synchronization failed.';
const ALLOWED_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'date']);

export interface GmailHistoricalSyncResult {
  mailboxAddress: string;
  contentMode: GmailContentMode;
  syncRunId: string;
  recordsProcessed: number;
  recordsPersisted: number;
}

export interface GmailHistoricalMailboxFailure {
  mailboxAddress: string;
  safeMessage: string;
}

export interface GmailHistoricalAllResult {
  completed: GmailHistoricalSyncResult[];
  failed: GmailHistoricalMailboxFailure[];
}

export interface GmailMessageEnvelope {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: Date;
  historyId: string | null;
  sizeEstimate: number | null;
  payload: Record<string, unknown> | null;
}

interface SanitizedHeaders { name: string; value: string; }
interface AttachmentMetadata { filename: string; mimeType: string | null; size: number | null; }
interface ContentPayload { plainText: string[]; html: string[]; attachments: AttachmentMetadata[]; }

type GmailAuthorizationService = Pick<typeof googleWorkspaceAuthService, 'getGmailAuthorization'>;
type DirectoryService = Pick<typeof googleWorkspaceDirectoryService, 'discoverActiveMailboxes'>;



const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const safeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.message === SAFE_FAILURE && error.cause) return safeErrorMessage(error.cause);
    const msg = error.message;
    if (
      msg.startsWith('Mailbox is not eligible') ||
      msg.startsWith('Google Workspace Gmail historical synchronization requires') ||
      msg.includes('already running for this mailbox')
    ) {
      return msg;
    }
  }

  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    const response = obj.response as { status?: unknown } | undefined;
    if (typeof response?.status === 'number') {
      if (response.status === 401 || response.status === 403) return `Google authentication or permission failure (HTTP ${response.status}).`;
      return `${SAFE_FAILURE.slice(0, -1)} (HTTP ${response.status}).`;
    }

    const code = obj.code;
    if (typeof code === 'string') {
      if (code === '42P01') return 'Database table is missing. Have migrations been run?';
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'Database connection failed.';
    }

    if (obj.name === 'GaxiosError' || (error instanceof Error && error.message.includes('invalid_grant'))) {
      return 'Google authentication or permission failure (invalid credentials or unauthorized scope).';
    }
  }
  return SAFE_FAILURE;
};

export const isRetryable = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' && (status === 408 || status === 429 || status >= 500);
};

const parseInternalDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const readString = (record: Record<string, unknown>, field: string): string | null => {
  const value = record[field];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

const readStringArray = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const readHeaders = (payload: Record<string, unknown> | null): SanitizedHeaders[] => {
  if (!payload || !Array.isArray(payload.headers)) return [];
  return payload.headers.flatMap((entry): SanitizedHeaders[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') return [];
    return ALLOWED_HEADERS.has(entry.name.toLowerCase()) ? [{ name: entry.name, value: entry.value }] : [];
  });
};

const decodeBase64Url = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

const collectContent = (node: Record<string, unknown>, output: ContentPayload): void => {
  const filename = typeof node.filename === 'string' ? node.filename : '';
  const mimeType = typeof node.mimeType === 'string' ? node.mimeType : null;
  const body = isRecord(node.body) ? node.body : null;
  const attachmentId = body && typeof body.attachmentId === 'string' ? body.attachmentId : null;
  const size = body && typeof body.size === 'number' && Number.isFinite(body.size) ? body.size : null;
  if (filename !== '' || attachmentId !== null) {
    output.attachments.push({ filename, mimeType, size });
    return;
  }
  if (body && typeof body.data === 'string') {
    const content = decodeBase64Url(body.data);
    if (mimeType === 'text/plain') output.plainText.push(content);
    if (mimeType === 'text/html') output.html.push(content);
  }
  if (Array.isArray(node.parts)) {
    for (const part of node.parts) if (isRecord(part)) collectContent(part, output);
  }
};

export const hasLockedAuthorization = (authorization: GmailAuthorizationContext): boolean => {
  const expectedScope = authorization.mailbox.contentMode === 'CONTENT' ? GMAIL_READONLY_SCOPE : GMAIL_METADATA_SCOPE;
  return authorization.subject === authorization.mailbox.normalizedAddress && authorization.scope === expectedScope;
};
export const normalizeMessage = (input: unknown): GmailMessageEnvelope | null => {
  if (!isRecord(input)) return null;
  const id = readString(input, 'id');
  const threadId = readString(input, 'threadId');
  const internalDate = parseInternalDate(input.internalDate);
  if (!id || !threadId || !internalDate) return null;
  return {
    id,
    threadId,
    labelIds: readStringArray(input.labelIds),
    internalDate,
    historyId: readString(input, 'historyId'),
    sizeEstimate: typeof input.sizeEstimate === 'number' && Number.isFinite(input.sizeEstimate) ? input.sizeEstimate : null,
    payload: isRecord(input.payload) ? input.payload : null,
  };
};

export const buildMetadataPayload = (message: GmailMessageEnvelope): Record<string, unknown> => ({
  id: message.id,
  threadId: message.threadId,
  labelIds: message.labelIds,
  internalDate: String(message.internalDate.getTime()),
  historyId: message.historyId,
  sizeEstimate: message.sizeEstimate,
  headers: readHeaders(message.payload),
});

export const buildContentPayload = (message: GmailMessageEnvelope): Record<string, unknown> => {
  const content: ContentPayload = { plainText: [], html: [], attachments: [] };
  if (message.payload) collectContent(message.payload, content);
  
  // CRITICAL: Email content must NOT be permanently stored in the warehouse/database.
  // Gmail message content may only exist transiently in memory for downstream classification.
  // We extract plainText/html here to verify we can, but discard them before persistence.
  return {
    ...buildMetadataPayload(message),
    attachmentMetadata: content.attachments,
  };
};

export class GmailHistoricalSyncService {
  public constructor(
    private readonly authService: GmailAuthorizationService = googleWorkspaceAuthService,
    private readonly directoryService: DirectoryService = googleWorkspaceDirectoryService,
    private readonly repository: GmailHistoricalRepository = gmailHistoricalRepository,
    private readonly historicalDays: number = env.GOOGLE_GMAIL_HISTORICAL_DAYS,
    private readonly now: () => number = Date.now,
    private readonly classificationHook: GmailClassificationHook = gmailClassificationHook,
  ) {}

  public async runMailbox(mailboxAddress: string, explicitCutoff?: Date): Promise<GmailHistoricalSyncResult> {
    (global as any).__GMAIL_SYNC_STAGE = 'historical fallback authorization/discovery';
    const mailboxes = await this.directoryService.discoverActiveMailboxes();
    const isDiscovered = mailboxes.some((m) => m.normalizedAddress === mailboxAddress.toLowerCase().trim());
    if (!isDiscovered) throw new Error('Mailbox is not eligible, suspended, archived, or not found in Google Workspace directory.');

    const authorization = this.authService.getGmailAuthorization(mailboxAddress);
    if (!isEligibleGmailSynchronizationMailbox(authorization.mailbox) || !hasLockedAuthorization(authorization)) throw new Error('Google Workspace Gmail historical synchronization requires a correctly authorized eligible mailbox.');
    
    (global as any).__GMAIL_SYNC_STAGE = 'historical lock acquisition';
    return this.repository.withMailboxLock(authorization.mailbox.normalizedAddress, async () => this.runLocked(authorization, explicitCutoff));
  }

  public async runAllEligibleMailboxes(): Promise<GmailHistoricalAllResult> {
    const completed: GmailHistoricalSyncResult[] = [];
    const failed: GmailHistoricalMailboxFailure[] = [];
    const mailboxes = await this.directoryService.discoverActiveMailboxes();
    for (const mailbox of mailboxes) {
      try { completed.push(await this.runMailbox(mailbox.normalizedAddress)); }
      catch { failed.push({ mailboxAddress: mailbox.normalizedAddress, safeMessage: SAFE_FAILURE }); }
    }
    return { completed, failed };
  }

  private async runLocked(authorization: GmailAuthorizationContext, explicitCutoff?: Date): Promise<GmailHistoricalSyncResult> {
    const entityType = `GmailHistorical:${authorization.mailbox.normalizedAddress}`;
    (global as any).__GMAIL_SYNC_STAGE = 'interrupted-run recovery';
    await this.repository.recoverInterruptedRun(entityType);
    
    (global as any).__GMAIL_SYNC_STAGE = 'mailbox ensure';
    const mailbox = await this.repository.ensureMailbox(authorization.mailbox);
    let syncRunId: string | null = null;
    let processed = 0;
    let persisted = 0;
    try {
      (global as any).__GMAIL_SYNC_STAGE = 'sync-run creation';
      syncRunId = await this.repository.createSyncRun(entityType);
      
      (global as any).__GMAIL_SYNC_STAGE = 'historical synchronization';
      const cutoff = explicitCutoff ?? new Date(this.now() - this.historicalDays * 24 * 60 * 60 * 1000);
      // Capture before scanning so changes during the scan are replayed by
      // incremental sync rather than skipped by an end-of-scan checkpoint.
      const profile = await withRetry(async () => authorization.client.users.getProfile({ userId: 'me' }));
      const historyId = profile.data.historyId ? String(profile.data.historyId) : null;
      if (!historyId) throw new Error(SAFE_FAILURE);
      const seenMessageIds = new Set<string>();
      for (const label of INCLUDED_LABELS) {
        const result = await this.scanLabel(authorization, mailbox, syncRunId, label, cutoff, seenMessageIds);
        processed += result.processed;
        persisted += result.persisted;
      }
      await this.repository.completeMailbox(mailbox, syncRunId, processed, this.historicalDays, historyId);
      return { mailboxAddress: mailbox.normalizedMailboxAddress, contentMode: authorization.mailbox.contentMode, syncRunId, recordsProcessed: processed, recordsPersisted: persisted };
    } catch (error) {
      if (syncRunId) await this.repository.failSyncRun(syncRunId, processed, safeErrorMessage(error));
      throw new Error(SAFE_FAILURE, { cause: error });
    }
  }

  private async scanLabel(
    authorization: GmailAuthorizationContext,
    mailbox: GmailHistoricalMailbox,
    syncRunId: string,
    label: (typeof INCLUDED_LABELS)[number],
    cutoff: Date,
    seenMessageIds: Set<string>,
  ): Promise<{ processed: number; persisted: number }> {
    let pageToken: string | undefined;
    let stop = false;
    let processed = 0;
    let persisted = 0;
    while (!stop) {
      const listed = await withRetry(async () => authorization.client.users.messages.list({
        userId: 'me', maxResults: PAGE_SIZE, includeSpamTrash: false, labelIds: [label], ...(pageToken ? { pageToken } : {}),
      }));
      const writes: GmailHistoricalMessageWrite[] = [];
      const classifications: ClassificationPersistenceInput[] = [];
      const errors: GmailHistoricalError[] = [];
      for (const listedMessage of listed.data.messages ?? []) {
        if (typeof listedMessage.id !== 'string' || listedMessage.id.trim() === '') {
          errors.push({ sourceId: null, message: 'Gmail list response contained a message without a valid id.' });
          continue;
        }
        const listedMessageId = listedMessage.id;
        if (seenMessageIds.has(listedMessageId)) continue;
        seenMessageIds.add(listedMessageId);
        const raw = await withRetry(async () => authorization.client.users.messages.get({
          userId: 'me', id: listedMessageId, format: authorization.mailbox.contentMode === 'METADATA' ? 'metadata' : 'full',
        }));
        const message = normalizeMessage(raw.data);
        if (!message) {
          errors.push({ sourceId: listedMessageId, message: 'Gmail message response was malformed.' });
          continue;
        }
        if (message.labelIds.some((messageLabel) => EXCLUDED_LABELS.has(messageLabel))) continue;
        if (message.internalDate.getTime() < cutoff.getTime()) {
          continue;
        }
        // METADATA ingestion must never enter the Layer B hook.
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
        });
      }
      if (errors.length > 0) {
        await this.repository.commitBatch(mailbox, syncRunId, [], errors);
        throw new Error(SAFE_FAILURE);
      }
      persisted += classifications.length > 0 ? await this.repository.commitBatch(mailbox, syncRunId, writes, errors, classifications) : await this.repository.commitBatch(mailbox, syncRunId, writes, errors);
      processed += writes.length;
      pageToken = listed.data.nextPageToken;
      if (!pageToken) stop = true;
    }
    return { processed, persisted };
  }
}

export const withRetry = async <T>(request: () => Promise<T>, wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try { return await request(); }
    catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) break;
      await wait(100 * (2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(SAFE_FAILURE);
};

export const gmailHistoricalSyncService = new GmailHistoricalSyncService();
