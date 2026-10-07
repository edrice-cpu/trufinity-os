import { env } from '../../config/env';
import { resolveGmailMailboxPolicy } from './gmail-policy';
import { deriveEmailDecision, type EmailClassifier, type EmailClassifierInput } from './email-classifier';
import { emailClassifier, DisabledEmailClassifier } from './anthropic-email-classifier';
import type { ClassificationPersistenceInput } from './classification.repository';
import type { GmailAuthorizationContext } from './google-auth.service';
import type { GmailMessageEnvelope } from './gmail-historical.service';

const MAX_CLASSIFICATION_BODY_LENGTH = 20_000;

const readHeader = (payload: Record<string, unknown> | null, name: string): string | null => {
  if (!payload || !Array.isArray(payload.headers)) return null;
  const headers = payload.headers as unknown[];
  const header = headers.find((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.name === 'string' && candidate.name.toLowerCase() === name.toLowerCase();
  });
  if (!header || typeof header !== 'object' || header === null || Array.isArray(header)) return null;
  const value = (header as Record<string, unknown>).value;
  return typeof value === 'string' ? value : null;
};

const extractAddress = (value: string): string | null => {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim().toLowerCase() || null;
};

const extractPlainText = (payload: Record<string, unknown> | null): string => {
  const parts: string[] = [];
  const visit = (node: Record<string, unknown>): void => {
    const mimeType = typeof node.mimeType === 'string' ? node.mimeType : '';
    const body = typeof node.body === 'object' && node.body !== null && !Array.isArray(node.body) ? node.body as Record<string, unknown> : null;
    if (mimeType === 'text/plain' && typeof body?.data === 'string') {
      try { parts.push(Buffer.from(body.data, 'base64url').toString('utf8')); } catch { /* malformed content is simply omitted */ }
    }
    if (Array.isArray(node.parts)) for (const child of node.parts) if (typeof child === 'object' && child !== null && !Array.isArray(child)) visit(child as Record<string, unknown>);
  };
  if (payload) visit(payload);
  return parts.join('\n').slice(0, MAX_CLASSIFICATION_BODY_LENGTH);
};

export interface GmailClassificationHook {
  classifyMessage(authorization: GmailAuthorizationContext, message: GmailMessageEnvelope, mailboxId?: string): Promise<ClassificationPersistenceInput | null>;
}

export class DefaultGmailClassificationHook implements GmailClassificationHook {
  public constructor(
    private readonly classifier: EmailClassifier = emailClassifier,
    private readonly enabled: boolean = env.GMAIL_CLASSIFIER_ENABLED,
    private readonly threshold: number | undefined = env.GMAIL_CLASSIFIER_CONFIDENCE_THRESHOLD,
  ) {}

  public async classifyMessage(authorization: GmailAuthorizationContext, message: GmailMessageEnvelope, mailboxId?: string): Promise<ClassificationPersistenceInput | null> {
    if (!this.enabled) return null;
    const policy = resolveGmailMailboxPolicy(authorization.mailbox.normalizedAddress);
    if (policy.contentMode !== 'CONTENT' || authorization.mailbox.contentMode !== 'CONTENT' || message.labelIds.some((label) => ['DRAFT', 'SPAM', 'TRASH'].includes(label))) return null;
    if (classifierIsDisabled(this.classifier)) throw new Error('Email classifier is enabled but incompletely configured.');
    const sender = extractAddress(readHeader(message.payload, 'from') ?? '');
    if (!sender || sender === authorization.mailbox.normalizedAddress) return null;
    if (this.threshold === undefined) throw new Error('Email classifier confidence threshold is not configured.');
    const input: EmailClassifierInput = {
      subject: readHeader(message.payload, 'subject') ?? '',
      bodyText: extractPlainText(message.payload),
    };
    const classification = await this.classifier.classify(input);
    const decision = deriveEmailDecision(classification, this.threshold);
    return {
      mailboxId: mailboxId ?? null,
      mailboxAddress: authorization.mailbox.normalizedAddress,
      providerMessageId: message.id,
      threadId: message.threadId,
      sourceReference: `gmail:${message.id}`,
      classification,
      decisionStatus: decision.state,
      modelProvider: env.GMAIL_CLASSIFIER_PROVIDER,
      modelName: env.GMAIL_CLASSIFIER_MODEL || 'configured-model',
      promptVersion: env.GMAIL_CLASSIFIER_PROMPT_VERSION,
      idempotencyKey: `gmail:${authorization.mailbox.normalizedAddress}:${message.id}:${env.GMAIL_CLASSIFIER_PROVIDER}:${env.GMAIL_CLASSIFIER_MODEL}:${env.GMAIL_CLASSIFIER_PROMPT_VERSION}`,
      classifiedAt: new Date(),
    };
  }
}

function classifierIsDisabled(classifier: EmailClassifier): boolean {
  return classifier instanceof DisabledEmailClassifier;
}

export const gmailClassificationHook = new DefaultGmailClassificationHook();
