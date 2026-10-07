import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import {
  EMAIL_CLASSIFICATION_LABELS,
  EmailClassification,
  EmailClassifier,
  EmailClassifierInput,
  EmailClassificationValidationError,
  parseEmailClassification,
} from './email-classifier';

export const EMAIL_CLASSIFIER_SYSTEM_PROMPT = `Classify the supplied email using exactly one of these labels: complaint, billing_dispute, cancellation_intent, legal_or_regulatory_threat, damage_claim, escalation_request, none.
Return only valid JSON with exactly these fields: label, confidence, reason.
Confidence must be a number from 0 to 1. Reason must be one concise single-line explanation.
Do not add fields, recommendations, calculations, identifiers, routing, ownership, SLA, or customer data.`;

export interface AnthropicMessagesClient {
  messages: {
    create(request: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string }[];
      /** Structured-output constraint; constrains Claude to emit JSON matching the schema. */
      output_config?: {
        format?: {
          type: 'json_schema';
          schema: Record<string, unknown>;
        } | null;
      };
    }): Promise<{
      /** SDK stop-reason enum; safe to inspect as a fixed string. */
      stop_reason: string | null;
      content: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

export interface ClassifierTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ClassifiedEmailWithUsage {
  classification: EmailClassification;
  usage: ClassifierTokenUsage;
}

export interface AnthropicEmailClassifierConfig {
  model: string;
  timeoutMs: number;
  maxRetries: number;
  promptVersion: string;
}

/**
 * Safe diagnostic category for a classifier failure. Captures only non-content
 * metadata (HTTP status, SDK error class, network code, stop reason enum).
 * Never exposes Claude response text, Gmail content, prompts, or credentials.
 *
 * Granular invalid-output subtypes allow the controlled CLI to identify the
 * exact cause (truncation, code fence, extra fields, bad label, etc.) without
 * logging any model-generated or email content.
 */
export type EmailClassifierFailureCategory =
  // granular invalid-output subtypes
  | 'response_truncated'       // stop_reason === 'max_tokens'
  | 'no_text_block'            // response has no content block with type === 'text'
  | 'json_parse_failure'       // response text is not valid JSON (e.g. code-fenced)
  | 'unsupported_fields'       // JSON has extra keys beyond label/confidence/reason
  | 'invalid_label'            // label is not a recognised enum value
  | 'invalid_confidence'       // confidence is not a finite number in [0, 1]
  | 'invalid_reason'           // reason is empty, multiline, or > MAX_REASON_LENGTH
  | 'invalid_structured_output' // any other schema-validation failure (fallback)
  // provider-side failure subtypes
  | 'provider_auth_error'
  | 'provider_model_error'
  | 'provider_rate_limit'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_server_error'
  | 'provider_http_error'
  | 'provider_unknown';

export class EmailClassifierError extends Error {
  public readonly category: EmailClassifierFailureCategory;
  public readonly providerStatus: number | null;
  constructor(
    message: string,
    category: EmailClassifierFailureCategory = 'provider_unknown',
    providerStatus: number | null = null,
  ) {
    super(message);
    this.name = 'EmailClassifierError';
    this.category = category;
    this.providerStatus = providerStatus;
  }
}

const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = candidate.response?.status ?? candidate.status;
  return (typeof status === 'number' && (status === 408 || status === 429 || status >= 500))
    || (typeof candidate.code === 'string' && RETRYABLE_CODES.has(candidate.code));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Extracts safe, non-content diagnostic fields from a provider SDK error.
 * Never reads response body text, error message content, or request fields.
 */
function categorizeProviderError(error: unknown): { category: EmailClassifierFailureCategory; providerStatus: number | null } {
  if (!error || typeof error !== 'object') return { category: 'provider_unknown', providerStatus: null };
  const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const status: number | null =
    typeof candidate.response?.status === 'number' ? candidate.response.status :
    typeof candidate.status === 'number' ? candidate.status :
    null;
  const code = typeof candidate.code === 'string' ? candidate.code : null;
  if (status === 401 || status === 403) return { category: 'provider_auth_error', providerStatus: status };
  if (status === 404) return { category: 'provider_model_error', providerStatus: status };
  if (status === 408 || code === 'ETIMEDOUT') return { category: 'provider_timeout', providerStatus: status };
  if (status === 429) return { category: 'provider_rate_limit', providerStatus: status };
  if (status !== null && status >= 500) return { category: 'provider_server_error', providerStatus: status };
  if (status !== null) return { category: 'provider_http_error', providerStatus: status };
  if (code === 'ECONNRESET' || code === 'EAI_AGAIN') return { category: 'provider_network_error', providerStatus: null };
  return { category: 'provider_unknown', providerStatus: null };
}

function buildPrompt(input: EmailClassifierInput): string {
  return `Classify this email. Subject and body are transient input and must not be repeated outside the JSON result.\nSubject: ${JSON.stringify(input.subject)}\nBody: ${JSON.stringify(input.bodyText)}`;
}

/**
 * JSON Schema passed via output_config.format to constrain Claude's response
 * to valid JSON with exactly the fields our validator expects. This prevents
 * code-fenced output, prose preambles, and extra fields without changing any
 * classification business logic or validation rules.
 *
 * Anthropic's structured-output JSON Schema does NOT support numerical
 * constraints (minimum/maximum) or string constraints (minLength/maxLength).
 * Using them returns HTTP 400. The API-level schema therefore constrains only
 * structure, types, enum values, required fields, and additionalProperties.
 *
 * Stricter business constraints (confidence range, reason length/single-line)
 * are enforced by parseEmailClassification() in the application layer.
 */
const EMAIL_CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      enum: [...EMAIL_CLASSIFICATION_LABELS],
    },
    confidence: {
      type: 'number',
    },
    reason: {
      type: 'string',
    },
  },
  required: ['label', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

export class AnthropicEmailClassifier implements EmailClassifier {
  constructor(
    private readonly client: AnthropicMessagesClient,
    private readonly config: AnthropicEmailClassifierConfig,
    private readonly waitFn: (milliseconds: number) => Promise<void> = wait,
  ) {
    if (!config.model || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || !Number.isInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 3 || !config.promptVersion) {
      throw new EmailClassifierError('Email classifier configuration is invalid.');
    }
  }

  async classify(input: EmailClassifierInput): Promise<EmailClassification> {
    const result = await this.classifyWithUsage(input);
    return result.classification;
  }

  async classifyWithUsage(input: EmailClassifierInput): Promise<ClassifiedEmailWithUsage> {
    if (!input || typeof input.subject !== 'string' || typeof input.bodyText !== 'string') {
      throw new EmailClassifierError('Email classifier input is invalid.');
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.client.messages.create({
          model: this.config.model,
          // 512 is a safe upper bound: the JSON payload (max ~350 chars) comfortably
          // fits within 200 tokens, but 512 prevents any risk of truncation from
          // prompt-overhead or model preamble on edge-case inputs.
          max_tokens: 512,
          system: EMAIL_CLASSIFIER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildPrompt(input) }],
          // Constrain Claude's response to valid JSON matching our schema.
          // This prevents code-fenced output and extra fields without changing
          // any classification or validation logic.
          output_config: {
            format: {
              type: 'json_schema',
              schema: EMAIL_CLASSIFICATION_JSON_SCHEMA,
            },
          },
        });

        // Check stop_reason before attempting to parse; 'max_tokens' means the
        // output was cut off and the JSON will be incomplete regardless of content.
        if (response.stop_reason === 'max_tokens') {
          throw new EmailClassifierError('Email classifier response was truncated.', 'response_truncated');
        }

        const text = response.content.find((block) => block.type === 'text')?.text;
        if (!text) {
          throw new EmailClassifierError('Email classifier returned no text block.', 'no_text_block');
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new EmailClassifierError('Email classifier response was not valid JSON.', 'json_parse_failure');
        }

        try {
          const classification = parseEmailClassification(parsed);
          const usage = response.usage;
          return {
            classification,
            usage: {
              inputTokens: typeof usage?.input_tokens === 'number' && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
              outputTokens: typeof usage?.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
            },
          };
        } catch (error) {
          if (error instanceof EmailClassificationValidationError) {
            // Map each validation failure to its specific safe category.
            const msg = error.message;
            let category: EmailClassifierFailureCategory = 'invalid_structured_output';
            if (msg.includes('unsupported fields')) category = 'unsupported_fields';
            else if (msg.includes('unsupported label')) category = 'invalid_label';
            else if (msg.includes('confidence')) category = 'invalid_confidence';
            else if (msg.includes('reason')) category = 'invalid_reason';
            throw new EmailClassifierError('Email classifier returned invalid structured output.', category);
          }
          throw error;
        }
      } catch (error) {
        // Non-retryable invalid-output categories: throw immediately, never retry.
        if (error instanceof EmailClassifierError) {
          const nonRetryableOutputCategories: EmailClassifierFailureCategory[] = [
            'response_truncated', 'no_text_block', 'json_parse_failure',
            'unsupported_fields', 'invalid_label', 'invalid_confidence',
            'invalid_reason', 'invalid_structured_output',
          ];
          if (nonRetryableOutputCategories.includes(error.category)) throw error;
        }
        if (attempt < this.config.maxRetries && isRetryable(error)) {
          await this.waitFn(100 * 2 ** attempt);
          continue;
        }
        const { category, providerStatus } = categorizeProviderError(error);
        throw new EmailClassifierError('Email classifier provider request failed.', category, providerStatus);
      }
    }
  }
}

export class DisabledEmailClassifier implements EmailClassifier {
  classify(): Promise<never> {
    return Promise.reject(new EmailClassifierError('Email classifier is disabled or incomplete.'));
  }
}

export function createConfiguredEmailClassifier(): EmailClassifier {
  if (!env.GMAIL_CLASSIFIER_ENABLED || env.GMAIL_CLASSIFIER_PROVIDER !== 'anthropic' || !env.GMAIL_CLASSIFIER_MODEL || !env.ANTHROPIC_API_KEY || env.GMAIL_CLASSIFIER_CONFIDENCE_THRESHOLD === undefined) {
    return new DisabledEmailClassifier();
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: env.GMAIL_CLASSIFIER_TIMEOUT_MS }) as unknown as AnthropicMessagesClient;
  return new AnthropicEmailClassifier(client, {
    model: env.GMAIL_CLASSIFIER_MODEL,
    timeoutMs: env.GMAIL_CLASSIFIER_TIMEOUT_MS,
    maxRetries: env.GMAIL_CLASSIFIER_MAX_RETRIES,
    promptVersion: env.GMAIL_CLASSIFIER_PROMPT_VERSION,
  });
}

export const emailClassifier = createConfiguredEmailClassifier();
