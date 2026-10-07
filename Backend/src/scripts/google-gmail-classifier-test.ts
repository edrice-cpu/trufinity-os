import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { isApprovedContentMailbox, normalizeMailboxAddress, resolveGmailMailboxPolicy } from '../modules/google/gmail-policy';
import { googleWorkspaceAuthService, type GoogleWorkspaceAuthService } from '../modules/google/google-auth.service';
import { normalizeMessage } from '../modules/google/gmail-historical.service';
import { AnthropicEmailClassifier, EmailClassifierError, type EmailClassifierFailureCategory } from '../modules/google/anthropic-email-classifier';
import { EmailClassificationValidationError, type EmailClassifier } from '../modules/google/email-classifier';
import { DefaultGmailClassificationHook } from '../modules/google/gmail-classification.service';
import { ClassificationPersistenceError, KnexEmailClassificationRepository, type ClassificationIdentity, type ClassificationPersistenceInput, type PersistedClassification } from '../modules/google/classification.repository';

export interface ControlledClassifierTestResult {
  mailbox: string;
  messageId: string | null;
  model: string;
  label: string | null;
  confidence: number | null;
  decisionStatus: string | null;
  newlyPersisted: boolean;
  workItemExists: boolean;
  skippedAlreadyClassified: number;
}

export interface ControlledClassifierRepository {
  hasClassification(identity: ClassificationIdentity): Promise<boolean>;
  persist(input: ClassificationPersistenceInput): Promise<PersistedClassification>;
}

type AuthService = Pick<GoogleWorkspaceAuthService, 'getGmailAuthorization'>;

const safeFailure = 'Controlled Gmail classifier verification failed.';
const MAX_CANDIDATES = 20;

type ControlledFailureStage = 'authorization_gmail_list' | 'candidate_metadata_fetch' | 'existing_classification_lookup' | 'selected_message_full_fetch' | 'anthropic_classification' | 'decision_payload_construction' | 'classification_persistence' | 'work_item_persistence';

class ControlledRunnerStageError extends Error {
  constructor(public readonly stage: ControlledFailureStage, public readonly cause: unknown) {
    super('Controlled Gmail classifier stage failed.');
    this.name = 'ControlledRunnerStageError';
  }
}

export async function runControlledClassifierTest(
  mailboxAddress: string,
  authService: AuthService = googleWorkspaceAuthService,
  classifier?: EmailClassifier,
  repository: ControlledClassifierRepository = new KnexEmailClassificationRepository(),
): Promise<ControlledClassifierTestResult> {
  const mailbox = normalizeMailboxAddress(mailboxAddress);
  if (!mailbox || !isApprovedContentMailbox(mailbox) || resolveGmailMailboxPolicy(mailbox).contentMode !== 'CONTENT') {
    throw new Error('Only an approved Gmail CONTENT mailbox may be selected.');
  }
  let currentStage: ControlledFailureStage = 'authorization_gmail_list';
  try {
  currentStage = 'authorization_gmail_list';
  const authorization = authService.getGmailAuthorization(mailbox);
  if (authorization.mailbox.contentMode !== 'CONTENT' || authorization.subject !== mailbox) throw new Error('Selected mailbox is not authorized for CONTENT access.');

  let pageToken: string | undefined;
  let selectedId: string | null = null;
  let selectedMetadata: ReturnType<typeof normalizeMessage> = null;
  let candidatesScanned = 0;
  let skippedAlreadyClassified = 0;
  do {
    currentStage = 'authorization_gmail_list';
    const listed = await authorization.client.users.messages.list({ userId: 'me', maxResults: 25, includeSpamTrash: false, labelIds: ['INBOX'], ...(pageToken ? { pageToken } : {}) });
    for (const listedMessage of listed.data.messages ?? []) {
      if (candidatesScanned >= MAX_CANDIDATES) break;
      candidatesScanned += 1;
      const candidateId = listedMessage?.id;
      if (typeof candidateId !== 'string' || candidateId.trim() === '') continue;
      currentStage = 'candidate_metadata_fetch';
      const metadataResponse = await authorization.client.users.messages.get({ userId: 'me', id: candidateId, format: 'metadata' });
      const metadata = normalizeMessage(metadataResponse.data);
      if (!metadata || metadata.labelIds.some((label) => ['DRAFT', 'SPAM', 'TRASH', 'DELETED'].includes(label))) continue;
      const sender = readFromHeader(metadata.payload);
      if (!sender || sender === mailbox) continue;
      currentStage = 'existing_classification_lookup';
      const alreadyClassified = await repository.hasClassification({
        mailboxAddress: mailbox,
        providerMessageId: candidateId,
        modelProvider: env.GMAIL_CLASSIFIER_PROVIDER,
        modelName: env.GMAIL_CLASSIFIER_MODEL,
        promptVersion: env.GMAIL_CLASSIFIER_PROMPT_VERSION,
      });
      if (alreadyClassified) {
        skippedAlreadyClassified += 1;
        continue;
      }
      selectedId = candidateId;
      selectedMetadata = metadata;
      break;
    }
    pageToken = typeof listed.data.nextPageToken === 'string' && listed.data.nextPageToken.trim() !== '' ? listed.data.nextPageToken : undefined;
  } while (!selectedId && pageToken && candidatesScanned < MAX_CANDIDATES);

  if (!selectedId || !selectedMetadata) return emptyResult(mailbox, null, skippedAlreadyClassified);
  currentStage = 'selected_message_full_fetch';
  const raw = await authorization.client.users.messages.get({ userId: 'me', id: selectedId, format: 'full' });
  const message = normalizeMessage(raw.data);
  if (!message || message.labelIds.some((label) => ['DRAFT', 'SPAM', 'TRASH', 'DELETED'].includes(label))) return emptyResult(mailbox, selectedId, skippedAlreadyClassified);
  const activeClassifier = classifier ?? createExplicitClassifierForControlledTest();
  const hook = new DefaultGmailClassificationHook(activeClassifier, true, env.GMAIL_CLASSIFIER_CONFIDENCE_THRESHOLD);
  currentStage = 'anthropic_classification';
  const classification = await hook.classifyMessage(authorization, message);
  if (!classification) return emptyResult(mailbox, message.id, skippedAlreadyClassified);
  currentStage = 'classification_persistence';
  const persisted = await repository.persist(classification);
  return {
    mailbox,
    messageId: message.id,
    model: env.GMAIL_CLASSIFIER_MODEL,
    label: classification.classification.label,
    confidence: classification.classification.confidence,
    decisionStatus: classification.decisionStatus,
    newlyPersisted: !persisted.duplicate,
    workItemExists: persisted.workItemId !== null,
    skippedAlreadyClassified,
  };
  } catch (error) {
    if (error instanceof ControlledRunnerStageError) throw error;
    if (error instanceof ClassificationPersistenceError) throw new ControlledRunnerStageError(error.stage, error.cause);
    const stage = error instanceof EmailClassifierError ? 'anthropic_classification' : error instanceof EmailClassificationValidationError ? 'decision_payload_construction' : currentStage;
    throw new ControlledRunnerStageError(stage, error);
  }
}

function readFromHeader(payload: Record<string, unknown> | null): string | null {
  if (!payload || !Array.isArray(payload.headers)) return null;
  const header: unknown = payload.headers.find((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && typeof (entry as Record<string, unknown>).name === 'string' && ((entry as Record<string, unknown>).name as string).toLowerCase() === 'from');
  if (!header || typeof header !== 'object' || header === null || Array.isArray(header)) return null;
  const value = (header as Record<string, unknown>).value;
  if (typeof value !== 'string') return null;
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim().toLowerCase() || null;
}

function emptyResult(mailbox: string, messageId: string | null = null, skippedAlreadyClassified = 0): ControlledClassifierTestResult {
  return { mailbox, messageId, model: env.GMAIL_CLASSIFIER_MODEL, label: null, confidence: null, decisionStatus: null, newlyPersisted: false, workItemExists: false, skippedAlreadyClassified };
}

function createExplicitClassifierForControlledTest(): EmailClassifier {
  if (env.GMAIL_CLASSIFIER_PROVIDER !== 'anthropic' || !env.ANTHROPIC_API_KEY || !env.GMAIL_CLASSIFIER_MODEL || env.GMAIL_CLASSIFIER_CONFIDENCE_THRESHOLD === undefined) {
    throw new Error('Classifier provider, model, API key, and confidence threshold must be configured for this controlled test.');
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: env.GMAIL_CLASSIFIER_TIMEOUT_MS });
  return new AnthropicEmailClassifier(client, {
    model: env.GMAIL_CLASSIFIER_MODEL,
    timeoutMs: env.GMAIL_CLASSIFIER_TIMEOUT_MS,
    maxRetries: env.GMAIL_CLASSIFIER_MAX_RETRIES,
    promptVersion: env.GMAIL_CLASSIFIER_PROMPT_VERSION,
  });
}

export function printResult(result: ControlledClassifierTestResult): void {
  console.log(`MAILBOX: ${result.mailbox}`);
  console.log(`MESSAGE ID: ${result.messageId ?? 'none'}`);
  console.log(`MODEL: ${result.model}`);
  console.log(`LABEL: ${result.label ?? 'none'}`);
  console.log(`CONFIDENCE: ${result.confidence ?? 'none'}`);
  console.log(`DECISION: ${result.decisionStatus ?? 'none'}`);
  console.log(`PERSISTENCE: ${result.newlyPersisted ? 'newly persisted' : 'already existed or no eligible message'}`);
  console.log(`WORK ITEM: ${result.workItemExists ? 'exists' : 'none'}`);
  console.log(`SKIPPED ALREADY CLASSIFIED: ${result.skippedAlreadyClassified}`);
}

function selectedMailbox(args: string[]): string {
  const index = args.indexOf('--mailbox');
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || args.some((arg, position) => arg === '--mailbox' && position !== index)) throw new Error('Usage: --mailbox <approved-content-mailbox>');
  return value;
}

export function printFailure(error: unknown): void {
  const failure = error instanceof ControlledRunnerStageError ? error : new ControlledRunnerStageError('authorization_gmail_list', error);
  const cause = failure.cause;
  console.error(safeFailure);
  console.error(`FAILED_STAGE=${failure.stage}`);
  console.error(`ERROR_CLASS=${errorClass(cause)}`);
  // When the classifier raised an EmailClassifierError, emit the safe diagnostic
  // category and (if available) the HTTP status. Never print message text, response
  // body, Claude output, or any content field.
  if (cause instanceof EmailClassifierError) {
    const category: EmailClassifierFailureCategory = cause.category;
    console.error(`ANTHROPIC_FAILURE=${category}`);
    if (cause.providerStatus !== null) console.error(`ANTHROPIC_STATUS=${cause.providerStatus}`);
  }
  const postgres = postgresDetails(cause);
  if (postgres.code) console.error(`POSTGRES_CODE=${postgres.code}`);
  if (postgres.constraint) console.error(`POSTGRES_CONSTRAINT=${postgres.constraint}`);
}

function errorClass(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

function postgresDetails(error: unknown): { code: string | null; constraint: string | null } {
  if (!error || typeof error !== 'object') return { code: null, constraint: null };
  const candidate = error as { code?: unknown; constraint?: unknown };
  return { code: typeof candidate.code === 'string' ? candidate.code : null, constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null };
}

async function main(): Promise<void> {
  try { printResult(await runControlledClassifierTest(selectedMailbox(process.argv.slice(2)))); }
  catch (error) { printFailure(error); process.exitCode = 1; }
}

if (require.main === module) void main();
