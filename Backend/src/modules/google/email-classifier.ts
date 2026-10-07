export const EMAIL_CLASSIFICATION_LABELS = [
  'complaint',
  'billing_dispute',
  'cancellation_intent',
  'legal_or_regulatory_threat',
  'damage_claim',
  'escalation_request',
  'none',
] as const;

export type EmailClassificationLabel = (typeof EMAIL_CLASSIFICATION_LABELS)[number];

export interface EmailClassifierInput {
  /** Transient input. Never persist these values as classifier fields. */
  subject: string;
  bodyText: string;
}

export interface EmailClassification {
  label: EmailClassificationLabel;
  confidence: number;
  reason: string;
}

export type EmailDecisionState = 'ESCALATION' | 'REVIEW_REQUIRED' | 'NONE';

export interface EmailDecision {
  state: EmailDecisionState;
  label: EmailClassificationLabel;
  confidence: number;
}

export interface EmailClassifier {
  classify(input: EmailClassifierInput): Promise<EmailClassification>;
}

export const EMAIL_CLASSIFICATION_MAX_REASON_LENGTH = 280;

const CLASSIFICATION_KEYS = new Set(['label', 'confidence', 'reason']);

export class EmailClassificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailClassificationValidationError';
  }
}

export function isEmailClassificationLabel(value: unknown): value is EmailClassificationLabel {
  return typeof value === 'string' && (EMAIL_CLASSIFICATION_LABELS as readonly string[]).includes(value);
}

export function parseEmailClassification(value: unknown): EmailClassification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EmailClassificationValidationError('Classifier output must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CLASSIFICATION_KEYS.has(key))) {
    throw new EmailClassificationValidationError('Classifier output contains unsupported fields.');
  }
  if (!isEmailClassificationLabel(record.label)) {
    throw new EmailClassificationValidationError('Classifier output contains an unsupported label.');
  }
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    throw new EmailClassificationValidationError('Classifier confidence must be a finite number between 0 and 1.');
  }
  if (typeof record.reason !== 'string' || record.reason.trim().length === 0 || /[\r\n]/.test(record.reason) || record.reason.length > EMAIL_CLASSIFICATION_MAX_REASON_LENGTH) {
    throw new EmailClassificationValidationError('Classifier reason must be a bounded single-line string.');
  }
  return { label: record.label, confidence: record.confidence, reason: record.reason.trim() };
}

export function deriveEmailDecision(classification: EmailClassification, confidenceThreshold: number): EmailDecision {
  const validated = parseEmailClassification(classification);
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new EmailClassificationValidationError('Confidence threshold must be between 0 and 1.');
  }
  const state: EmailDecisionState = validated.label === 'none'
    ? 'NONE'
    : validated.confidence >= confidenceThreshold ? 'ESCALATION' : 'REVIEW_REQUIRED';
  return { state, label: validated.label, confidence: validated.confidence };
}
