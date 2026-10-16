import { db } from '../database';
import { env } from '../config/env';
import { isApprovedContentMailbox, normalizeMailboxAddress } from '../modules/google/gmail-policy';
import { googleWorkspaceAuthService, type GoogleWorkspaceAuthService } from '../modules/google/google-auth.service';
import { normalizeMessage } from '../modules/google/gmail-historical.service';
import { AnthropicEmailClassifier, EmailClassifierError, type ClassifiedEmailWithUsage } from '../modules/google/anthropic-email-classifier';
import { deriveEmailDecision, type EmailClassifier } from '../modules/google/email-classifier';
import { KnexEmailClassificationRepository, computeResolutionDeadline, type ClassificationPersistenceInput, type PersistedClassification } from '../modules/google/classification.repository';
import { SmtpWorkItemNotifier, type WorkItemNotifier, type WorkItemNotificationInput } from '../modules/google/work-item-notifier';
import type { Knex } from 'knex';

const HARD_BATCH_LIMIT = 500;
const HARD_CALL_CAP = 500;
const MAX_RANGE_DAYS = 90;
const DEFAULT_DELAY_MS = 200;
const MAX_CLASSIFICATION_BODY_LENGTH = 20_000;
export const PROVIDER_HTTP_400_CIRCUIT_THRESHOLD = 3;

export interface HistoricalClassifyArgs {
  mailbox: string;
  from: Date;
  to: Date;
  dryRun: boolean;
  batchLimit: number;
  maxCalls: number;
  delayMs: number;
  noNotifications: boolean;
}

export interface HistoricalClassifyProgress {
  scanned: number;
  eligible: number;
  skippedAlreadyClassified: number;
  skippedOutbound: number;
  skippedDeleted: number;
  skippedNonLatest: number;
  skippedOutsideRange: number;
  attempted: number;
  succeeded: number;
  failed: number;
  none: number;
  escalation: number;
  reviewRequired: number;
  inputTokens: number;
  outputTokens: number;
  gmailFetchAttempts: number;
  gmailFetchFailures: number;
  normalizationFailures: number;
  anthropicFailures: number;
  persistenceFailures: number;
  failureCategories: Record<string, number>;
  notificationsSent: number;
  notificationFailures: number;
  elapsedMs: number;
  stoppedBySignal: boolean;
  stoppedByBatchLimit: boolean;
  stoppedByCallCap: boolean;
  consecutiveProviderHttp400: number;
  stoppedByProviderCircuitBreaker: boolean;
}

export function emptyProgress(): HistoricalClassifyProgress {
  return {
    scanned: 0, eligible: 0, skippedAlreadyClassified: 0, skippedOutbound: 0,
    skippedDeleted: 0, skippedNonLatest: 0, skippedOutsideRange: 0,
    attempted: 0, succeeded: 0, failed: 0, none: 0, escalation: 0, reviewRequired: 0,
    inputTokens: 0, outputTokens: 0,
    gmailFetchAttempts: 0, gmailFetchFailures: 0,
    normalizationFailures: 0, anthropicFailures: 0, persistenceFailures: 0,
    failureCategories: {},
    notificationsSent: 0, notificationFailures: 0,
    elapsedMs: 0,
    stoppedBySignal: false, stoppedByBatchLimit: false, stoppedByCallCap: false,
    consecutiveProviderHttp400: 0, stoppedByProviderCircuitBreaker: false,
  };
}

export type ClassificationDiagnosticStage = 'gmail_token' | 'gmail_fetch' | 'normalization' | 'anthropic' | 'persistence';
export interface ClassificationDiagnostic {
  ordinal: number;
  stage: ClassificationDiagnosticStage;
  category: string;
  status: number | null;
  errorClass: string;
  providerType?: string | null;
  providerCode?: string | null;
  validationReason?: string | null;
  parameterName?: string | null;
  numericLimit?: number | null;
}

/** Extracts only safe provider metadata; never reads error messages or payloads. */
export function classifyGmailFetchError(error: unknown): Omit<ClassificationDiagnostic, 'ordinal' | 'stage'> {
  if (!error || typeof error !== 'object') return { category: 'unknown', status: null, errorClass: 'UnknownError' };
  const candidate = error as { response?: { status?: unknown }; status?: unknown; code?: unknown };
  const status = typeof candidate.response?.status === 'number' ? candidate.response.status
    : typeof candidate.status === 'number' ? candidate.status : null;
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const errorClass = error instanceof Error ? error.name : 'ProviderError';
  const providerName = typeof (candidate as { name?: unknown }).name === 'string' ? (candidate as { name: string }).name : '';
  const safeMessage = error instanceof Error ? error.message.toLowerCase() : '';
  if (status === 401) return { category: 'authentication', status, errorClass };
  if (status === 403) return { category: 'permission_or_scope', status, errorClass };
  if (status === 404) return { category: 'message_not_found', status, errorClass };
  if (status === 408 || status === 429) return { category: 'rate_limited_or_timeout', status, errorClass };
  if (status !== null && status >= 500) return { category: 'provider_server', status, errorClass };
  if (error instanceof TypeError || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) {
    return { category: 'network', status, errorClass };
  }
  // Match only known authentication markers; never emit or retain the message.
  // Also catches google-auth-library wrapper errors (plain Error wrapping a GaxiosError
  // from the token endpoint) which lose the GaxiosError class but retain auth keywords.
  if (errorClass === 'GaxiosError' || providerName === 'GaxiosError' ||
      /invalid_grant|unauthorized_client|authentication failed|could not refresh access token|error fetching access token|refresh access token|token has been expired|token has been revoked/.test(safeMessage)) {
    return { category: 'authentication', status, errorClass };
  }
  return { category: 'provider_unknown', status, errorClass };
}

export function parseArgs(argv: string[]): HistoricalClassifyArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };

  const mailboxRaw = get('--mailbox');
  if (!mailboxRaw) throw new Error('--mailbox is required.');
  const mailbox = normalizeMailboxAddress(mailboxRaw);
  if (!mailbox) throw new Error('Invalid mailbox address.');
  if (!isApprovedContentMailbox(mailbox)) throw new Error(`Mailbox ${mailbox} is not an approved CONTENT mailbox.`);

  const fromStr = get('--from');
  const toStr = get('--to');
  if (!fromStr || !toStr) throw new Error('--from and --to date arguments are required.');
  const from = new Date(fromStr);
  const to = new Date(toStr);
  if (!Number.isFinite(from.getTime())) throw new Error(`Invalid --from date: ${fromStr}`);
  if (!Number.isFinite(to.getTime())) throw new Error(`Invalid --to date: ${toStr}`);
  if (from >= to) throw new Error('--from must be before --to.');
  const rangeDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (rangeDays > MAX_RANGE_DAYS) throw new Error(`Date range exceeds ${MAX_RANGE_DAYS} days (${rangeDays.toFixed(1)} days).`);
  if (to > new Date()) throw new Error('--to must not be in the future.');

  const dryRun = argv.includes('--dry-run');
  const noNotifications = argv.includes('--no-notifications');

  const batchLimitRaw = get('--batch-limit');
  const batchLimit = batchLimitRaw ? Number(batchLimitRaw) : HARD_BATCH_LIMIT;
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > HARD_BATCH_LIMIT) {
    throw new Error(`--batch-limit must be 1-${HARD_BATCH_LIMIT}.`);
  }

  const maxCallsRaw = get('--max-calls');
  const maxCalls = maxCallsRaw ? Number(maxCallsRaw) : HARD_CALL_CAP;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > HARD_CALL_CAP) {
    throw new Error(`--max-calls must be 1-${HARD_CALL_CAP}.`);
  }

  const delayMsRaw = get('--delay-ms');
  const delayMs = delayMsRaw ? Number(delayMsRaw) : DEFAULT_DELAY_MS;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10000) {
    throw new Error('--delay-ms must be 0-10000.');
  }

  return { mailbox, from, to, dryRun, batchLimit, maxCalls, delayMs, noNotifications };
}

interface EligibleRow {
  provider_message_id: string;
  mailbox_address: string;
  mailbox_id: string;
  internal_date: Date;
}

export async function queryEligibleMessages(
  args: HistoricalClassifyArgs,
  database: Knex = db,
): Promise<EligibleRow[]> {
  const mailboxRow = await database('google_gmail_mailboxes')
    .select('id')
    .where({ normalized_mailbox_address: args.mailbox, content_mode: 'CONTENT' })
    .first();
  if (!mailboxRow) return [];

  const result = await database.raw(`
    SELECT r.provider_message_id, r.mailbox_address, r.mailbox_id, r.internal_date
    FROM raw_gmail_messages r
    WHERE r.mailbox_id = ?
      AND r.is_latest = true
      AND r.is_deleted = false
      AND r.content_mode = 'CONTENT'
      AND r.internal_date >= ?
      AND r.internal_date < ?
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(r.payload->'headers') AS h
        WHERE lower(h->>'name') = 'from'
          AND lower(h->>'value') LIKE '%' || ? || '%'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM email_classification_results c
        WHERE c.mailbox_address = r.mailbox_address
          AND c.provider_message_id = r.provider_message_id
          AND c.model_provider = ?
          AND c.model_name = ?
          AND c.prompt_version = ?
      )
    ORDER BY r.internal_date ASC, r.provider_message_id ASC
    LIMIT ?
  `, [
    mailboxRow.id, args.from.toISOString(), args.to.toISOString(),
    args.mailbox,
    env.GMAIL_CLASSIFIER_PROVIDER, env.GMAIL_CLASSIFIER_MODEL, env.GMAIL_CLASSIFIER_PROMPT_VERSION,
    args.batchLimit,
  ]);

  return result.rows as EligibleRow[];
}

export async function runDryRun(
  args: HistoricalClassifyArgs,
  database: Knex = db,
): Promise<HistoricalClassifyProgress> {
  const progress = emptyProgress();
  const start = Date.now();
  const eligible = await queryEligibleMessages(args, database);
  progress.eligible = eligible.length;
  progress.scanned = eligible.length;
  progress.elapsedMs = Date.now() - start;
  return progress;
}


function extractSubject(payload: Record<string, unknown> | null): string {
  if (!payload || !Array.isArray(payload.headers)) return '';
  for (const entry of payload.headers) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const h = entry as Record<string, unknown>;
      if (typeof h.name === 'string' && h.name.toLowerCase() === 'subject' && typeof h.value === 'string') return h.value;
    }
  }
  return '';
}

function extractPlainText(payload: Record<string, unknown> | null): string {
  const parts: string[] = [];
  const visit = (node: Record<string, unknown>): void => {
    const mimeType = typeof node.mimeType === 'string' ? node.mimeType : '';
    const body = typeof node.body === 'object' && node.body !== null && !Array.isArray(node.body) ? node.body as Record<string, unknown> : null;
    if (mimeType === 'text/plain' && typeof body?.data === 'string') {
      try { parts.push(Buffer.from(body.data, 'base64url').toString('utf8')); } catch { /* skip malformed */ }
    }
    if (Array.isArray(node.parts)) for (const child of node.parts) if (typeof child === 'object' && child !== null && !Array.isArray(child)) visit(child as Record<string, unknown>);
  };
  if (payload) visit(payload);
  return parts.join('\n').slice(0, MAX_CLASSIFICATION_BODY_LENGTH);
}

function extractSender(payload: Record<string, unknown> | null): string | null {
  if (!payload || !Array.isArray(payload.headers)) return null;
  for (const entry of payload.headers) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const h = entry as Record<string, unknown>;
      if (typeof h.name === 'string' && h.name.toLowerCase() === 'from' && typeof h.value === 'string') {
        const match = /<([^>]+)>/.exec(h.value);
        return (match?.[1] ?? h.value).trim().toLowerCase() || null;
      }
    }
  }
  return null;
}

function extractSenderName(payload: Record<string, unknown> | null): string | null {
  if (!payload || !Array.isArray(payload.headers)) return null;
  for (const entry of payload.headers) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const h = entry as Record<string, unknown>;
      if (typeof h.name === 'string' && h.name.toLowerCase() === 'from' && typeof h.value === 'string') {
        const nameMatch = /^([^<]+)</.exec(h.value);
        return nameMatch?.[1]?.trim() || null;
      }
    }
  }
  return null;
}

function extractHeaderValue(payload: Record<string, unknown> | null, headerName: string): string | null {
  if (!payload || !Array.isArray(payload.headers)) return null;
  const lower = headerName.toLowerCase();
  for (const entry of payload.headers) {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const h = entry as Record<string, unknown>;
      if (typeof h.name === 'string' && h.name.toLowerCase() === lower && typeof h.value === 'string') return h.value.trim() || null;
    }
  }
  return null;
}

export interface HistoricalClassifyDeps {
  database: Knex;
  authService: Pick<GoogleWorkspaceAuthService, 'getGmailAuthorization'>;
  classifier: EmailClassifier & { classifyWithUsage?: (input: { subject: string; bodyText: string }) => Promise<ClassifiedEmailWithUsage> };
  repository: KnexEmailClassificationRepository;
  notifier: WorkItemNotifier;
  waitFn: (ms: number) => Promise<void>;
  diagnostic?: (event: ClassificationDiagnostic) => void;
}

function safeErrorClass(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

function recordDiagnostic(progress: HistoricalClassifyProgress, deps: HistoricalClassifyDeps, event: ClassificationDiagnostic): void {
  progress.failureCategories[event.category] = (progress.failureCategories[event.category] ?? 0) + 1;
  deps.diagnostic?.(event);
}

export async function runClassify(
  args: HistoricalClassifyArgs,
  deps: HistoricalClassifyDeps,
  signalRef: { stopped: boolean } = { stopped: false },
): Promise<HistoricalClassifyProgress> {
  const progress = emptyProgress();
  const start = Date.now();

  if (!args.noNotifications && deps.notifier.recoverPendingNotifications) {
    try {
      progress.notificationsSent += await deps.notifier.recoverPendingNotifications();
    } catch {
      progress.notificationFailures += 1;
    }
  }

  const eligible = await queryEligibleMessages(args, deps.database);
  progress.eligible = eligible.length;
  progress.scanned = eligible.length;

  if (eligible.length === 0) {
    progress.elapsedMs = Date.now() - start;
    return progress;
  }

  const authorization = deps.authService.getGmailAuthorization(args.mailbox);

  for (const [index, row] of eligible.entries()) {
    if (signalRef.stopped) { progress.stoppedBySignal = true; break; }
    if (progress.attempted >= args.maxCalls) { progress.stoppedByCallCap = true; break; }
    if (progress.succeeded + progress.failed >= args.batchLimit) { progress.stoppedByBatchLimit = true; break; }

    // Stage: gmail_token — explicit token acquisition before the message fetch.
    // Separates token/delegation failures (authentication category) from
    // message retrieval failures; google-auth-library caches the token after
    // the first authorize() so subsequent rows in the same batch skip the
    // network round-trip to the token endpoint.
    try {
      if (typeof authorization.auth.authorize === 'function') {
        await authorization.auth.authorize();
      }
    } catch (tokenError) {
      progress.gmailFetchFailures += 1;
      progress.failed += 1;
      recordDiagnostic(progress, deps, { ordinal: index + 1, stage: 'gmail_token', ...classifyGmailFetchError(tokenError) });
      if (args.delayMs > 0 && !signalRef.stopped) await deps.waitFn(args.delayMs);
      continue;
    }

    let raw: { data?: unknown };
    try {
      progress.gmailFetchAttempts += 1;
      raw = await authorization.client.users.messages.get({
        userId: 'me', id: row.provider_message_id, format: 'full',
      });
    } catch (error) {
      progress.gmailFetchFailures += 1;
      progress.failed += 1;
      recordDiagnostic(progress, deps, { ordinal: index + 1, stage: 'gmail_fetch', ...classifyGmailFetchError(error) });
      if (args.delayMs > 0 && !signalRef.stopped) await deps.waitFn(args.delayMs);
      continue;
    }

    let message: ReturnType<typeof normalizeMessage>;
    try {
      message = normalizeMessage(raw.data);
    } catch (error) {
      progress.failed += 1;
      progress.normalizationFailures += 1;
      recordDiagnostic(progress, deps, {
        ordinal: index + 1, stage: 'normalization', category: 'invalid_message_response', status: null, errorClass: safeErrorClass(error),
      });
      if (args.delayMs > 0 && !signalRef.stopped) await deps.waitFn(args.delayMs);
      continue;
    }
    if (!message) {
      progress.gmailFetchFailures += 1;
      progress.normalizationFailures += 1;
      recordDiagnostic(progress, deps, {
        ordinal: index + 1, stage: 'normalization', category: 'invalid_message_response', status: null, errorClass: 'InvalidMessageResponse',
      });
      if (args.delayMs > 0 && !signalRef.stopped) await deps.waitFn(args.delayMs);
      continue;
    }

    try {
      const sender = extractSender(message.payload);
      if (!sender || sender === args.mailbox) { progress.skippedOutbound += 1; continue; }

      const senderName = extractSenderName(message.payload);
      const subject = extractSubject(message.payload);
      const rfc822MessageId = extractHeaderValue(message.payload, 'message-id');
      const bodyText = extractPlainText(message.payload);

      progress.attempted += 1;
      let classification;
      try {
        if (typeof deps.classifier.classifyWithUsage === 'function') {
          const classified = await deps.classifier.classifyWithUsage({ subject, bodyText });
          classification = classified.classification;
          progress.inputTokens += classified.usage.inputTokens;
          progress.outputTokens += classified.usage.outputTokens;
        } else {
          classification = await deps.classifier.classify({ subject, bodyText });
        }
      } catch (error) {
        progress.failed += 1;
        progress.anthropicFailures += 1;
        // EmailClassifierError carries a structured category from the classifier; use it
        // directly rather than passing through the Gmail/gaxios-oriented classifyGmailFetchError,
        // which would always map it to provider_unknown.
        const diag = error instanceof EmailClassifierError
          ? {
            category: error.category, status: error.providerStatus, errorClass: 'EmailClassifierError',
            providerType: error.providerDiagnostic.providerType,
            providerCode: error.providerDiagnostic.providerCode,
            validationReason: error.providerDiagnostic.validationReason,
            parameterName: error.providerDiagnostic.parameterName,
            numericLimit: error.providerDiagnostic.numericLimit,
          }
          : classifyGmailFetchError(error);
        recordDiagnostic(progress, deps, { ordinal: index + 1, stage: 'anthropic', ...diag });
        // Any HTTP 400 observed at the Anthropic stage is request/provider
        // validation failure, even if an SDK wrapper obscures the category.
        if (diag.status === 400) {
          progress.consecutiveProviderHttp400 += 1;
        } else {
          progress.consecutiveProviderHttp400 = 0;
        }
        if (progress.consecutiveProviderHttp400 >= PROVIDER_HTTP_400_CIRCUIT_THRESHOLD) {
          progress.stoppedByProviderCircuitBreaker = true;
          break;
        }
        if (args.delayMs > 0 && !signalRef.stopped) await deps.waitFn(args.delayMs);
        continue;
      }
      progress.consecutiveProviderHttp400 = 0;
      const decision = deriveEmailDecision(classification, env.GMAIL_CLASSIFIER_CONFIDENCE_THRESHOLD!);

      const classifiedAt = new Date();
      const persistInput: ClassificationPersistenceInput = {
        mailboxId: row.mailbox_id,
        mailboxAddress: row.mailbox_address,
        providerMessageId: row.provider_message_id,
        threadId: message.threadId,
        sourceReference: `gmail:${row.provider_message_id}`,
        classification,
        decisionStatus: decision.state,
        modelProvider: env.GMAIL_CLASSIFIER_PROVIDER,
        modelName: env.GMAIL_CLASSIFIER_MODEL,
        promptVersion: env.GMAIL_CLASSIFIER_PROMPT_VERSION,
        classifiedAt,
        idempotencyKey: `gmail:${row.mailbox_address}:${row.provider_message_id}:${env.GMAIL_CLASSIFIER_PROVIDER}:${env.GMAIL_CLASSIFIER_MODEL}:${env.GMAIL_CLASSIFIER_PROMPT_VERSION}`,
      };

      let persisted: PersistedClassification;
      try {
        persisted = await deps.repository.persist(persistInput);
      } catch (error) {
        progress.failed += 1;
        progress.persistenceFailures += 1;
        recordDiagnostic(progress, deps, {
          ordinal: index + 1, stage: 'persistence', category: 'database_persistence_failed', status: null, errorClass: safeErrorClass(error),
        });
        if (args.delayMs > 0 && !signalRef.stopped) await deps.waitFn(args.delayMs);
        continue;
      }

      if (persisted.duplicate) { progress.skippedAlreadyClassified += 1; }
      else { progress.succeeded += 1; }

      if (decision.state === 'NONE') progress.none += 1;
      else if (decision.state === 'ESCALATION') progress.escalation += 1;
      else progress.reviewRequired += 1;

      if (!args.noNotifications && persisted.workItemId && !persisted.duplicate) {
        const workType = decision.state as 'ESCALATION' | 'REVIEW_REQUIRED';
        const resolutionDeadline = computeResolutionDeadline(workType, classifiedAt);
        const notifInput: WorkItemNotificationInput = {
          workItemId: persisted.workItemId,
          classificationId: persisted.id,
          workType,
          classificationLabel: classification.label,
          confidence: classification.confidence,
          mailboxAddress: row.mailbox_address,
          providerMessageId: row.provider_message_id,
          sourceReference: persistInput.sourceReference ?? null,
          classifiedAt,
          resolutionDeadline,
          senderEmail: sender,
          senderName: senderName ?? null,
          subject: subject || null,
          internalDate: message.internalDate,
          classifierReason: classification.reason ?? null,
          rfc822MessageId: rfc822MessageId ?? null,
        };
        try {
          const sent = await deps.notifier.sendNotification(notifInput);
          if (sent) progress.notificationsSent += 1;
        } catch {
          progress.notificationFailures += 1;
        }
      }
    } catch (error) {
      progress.failed += 1;
      progress.normalizationFailures += 1;
      recordDiagnostic(progress, deps, {
        ordinal: index + 1, stage: 'normalization', category: 'message_processing_failed', status: null, errorClass: safeErrorClass(error),
      });
    }
    if (args.delayMs > 0 && !signalRef.stopped) await deps.waitFn(args.delayMs);
  }

  progress.elapsedMs = Date.now() - start;
  return progress;
}

export function printProgress(progress: HistoricalClassifyProgress, dryRun: boolean): void {
  console.log(`\n=== HISTORICAL CLASSIFICATION ${dryRun ? 'DRY-RUN' : 'RESULT'} ===`);
  console.log(`  Scanned:               ${progress.scanned}`);
  console.log(`  Eligible:              ${progress.eligible}`);
  if (!dryRun) {
    console.log(`  Skipped (classified):  ${progress.skippedAlreadyClassified}`);
    console.log(`  Skipped (outbound):    ${progress.skippedOutbound}`);
    console.log(`  Gmail fetches:         ${progress.gmailFetchAttempts}`);
    console.log(`  Gmail fetch failures:  ${progress.gmailFetchFailures}`);
    console.log(`  Normalization failures: ${progress.normalizationFailures}`);
    console.log(`  Anthropic failures:     ${progress.anthropicFailures}`);
    console.log(`  Persistence failures:   ${progress.persistenceFailures}`);
    console.log(`  Failure categories:     ${JSON.stringify(progress.failureCategories)}`);
    console.log(`  Attempted:             ${progress.attempted}`);
    console.log(`  Succeeded:             ${progress.succeeded}`);
    console.log(`  Failed:                ${progress.failed}`);
    console.log(`  NONE:                  ${progress.none}`);
    console.log(`  ESCALATION:            ${progress.escalation}`);
    console.log(`  REVIEW_REQUIRED:       ${progress.reviewRequired}`);
    console.log(`  Notifications sent:    ${progress.notificationsSent}`);
    console.log(`  Notification failures: ${progress.notificationFailures}`);
    console.log(`  Input tokens:          ${progress.inputTokens}`);
    console.log(`  Output tokens:         ${progress.outputTokens}`);
  }
  console.log(`  Elapsed:               ${(progress.elapsedMs / 1000).toFixed(1)}s`);
  if (progress.stoppedBySignal) console.log(`  STOPPED by SIGINT`);
  if (progress.stoppedByBatchLimit) console.log(`  STOPPED by batch limit`);
  if (progress.stoppedByCallCap) console.log(`  STOPPED by call cap`);
  if (progress.stoppedByProviderCircuitBreaker) {
    console.log(`  STOPPED by provider HTTP 400 circuit breaker (${PROVIDER_HTTP_400_CIRCUIT_THRESHOLD} consecutive failures)`);
  }
  console.log('');
}

const suppressedNotifier: WorkItemNotifier = {
  sendNotification: async () => false,
  hasNotificationBeenSent: async () => false,
  recoverPendingNotifications: async () => 0,
};

function createDefaultDeps(args: HistoricalClassifyArgs): HistoricalClassifyDeps {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: env.GMAIL_CLASSIFIER_TIMEOUT_MS });
  return {
    database: db,
    authService: googleWorkspaceAuthService,
    classifier: new AnthropicEmailClassifier(client, {
      model: env.GMAIL_CLASSIFIER_MODEL,
      timeoutMs: env.GMAIL_CLASSIFIER_TIMEOUT_MS,
      maxRetries: env.GMAIL_CLASSIFIER_MAX_RETRIES,
      promptVersion: env.GMAIL_CLASSIFIER_PROMPT_VERSION,
    }),
    repository: new KnexEmailClassificationRepository(),
    notifier: args.noNotifications ? suppressedNotifier : new SmtpWorkItemNotifier(),
    waitFn: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    diagnostic: (event) => {
      console.warn(`[historical-classify] row=${event.ordinal} stage=${event.stage} category=${event.category} status=${event.status ?? 'none'} error=${event.errorClass} type=${event.providerType ?? 'none'} code=${event.providerCode ?? 'none'} reason=${event.validationReason ?? 'none'} parameter=${event.parameterName ?? 'none'} limit=${event.numericLimit ?? 'none'}`);
    },
  };
}

async function main(): Promise<void> {
  const signalRef = { stopped: false };
  process.on('SIGINT', () => {
    if (signalRef.stopped) process.exit(1);
    console.log('\nSIGINT received — finishing current message and stopping...');
    signalRef.stopped = true;
  });

  try {
    const args = parseArgs(process.argv.slice(2));
    console.log(`Mailbox:     ${args.mailbox}`);
    console.log(`Date range:  ${args.from.toISOString()} → ${args.to.toISOString()}`);
    console.log(`Mode:        ${args.dryRun ? 'DRY-RUN' : 'CLASSIFY'}`);
    console.log(`Batch limit: ${args.batchLimit}`);
    console.log(`Max calls:   ${args.maxCalls}`);
    console.log(`Delay:       ${args.delayMs}ms`);
    console.log(`Notifications: ${args.noNotifications ? 'DISABLED (--no-notifications)' : 'ENABLED'}`);

    if (args.dryRun) {
      const progress = await runDryRun(args);
      printProgress(progress, true);
    } else {
      const deps = createDefaultDeps(args);
      const progress = await runClassify(args, deps, signalRef);
      printProgress(progress, false);
      // A circuit-breaker stop is an incomplete run. Preserve successful rows,
      // but make the process non-zero so wrappers cannot mark the window done.
      if (progress.stoppedByProviderCircuitBreaker) process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Historical classification failed.');
    process.exitCode = 1;
  }
}

if (require.main === module) void main().finally(() => db.destroy());
