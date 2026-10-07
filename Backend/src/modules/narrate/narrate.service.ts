import type { Knex } from 'knex';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../../database';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';

export interface DetectedAlertRow {
  id: string;
  rule_code: string;
  dimension: string;
  period_start: Date;
  period_end: Date;
  baseline_start: Date | null;
  baseline_end: Date | null;
  metric_value: string;
  baseline_value: string | null;
  details: Record<string, unknown>;
}

export interface NarrationClient {
  narrate(alert: DetectedAlertRow): Promise<string>;
}

export class NarrativeValidationError extends Error {
  public constructor(
    public readonly alertId: string,
    public readonly offendingNumbers: number[],
  ) {
    super(`Narrate: generated text contains numbers not present in the source payload: ${offendingNumbers.join(', ')}`);
    this.name = 'NarrativeValidationError';
  }
}

const RULE_DESCRIPTIONS: Record<string, string> = {
  'D-01': 'Tenant-wide call booking rate has declined compared to the trailing 4-week average.',
  'D-06': 'An objection category mentioned on calls has spiked compared to its trailing 4-week average.',
  'F-04': 'The share of recently-issued invoices that are now overdue and unpaid has risen compared to the trailing 4-week cohort average.',
  'F-04c': "A single customer's outstanding receivable balance makes up an outsized share of total outstanding accounts receivable.",
  'F-03': 'The aggregate discount rate on recently-issued QuickBooks invoices has risen compared to the trailing 4-week average.',
  'F-04d': 'The total dollar amount of QuickBooks credit memos issued in the current week has spiked compared to the trailing 4-week weekly average.',
  'F-05': "ServiceTitan's and QuickBooks' recorded revenue for the current week's invoices diverge by more than the configured threshold.",
};

// Percentage-rate rules whose metric/baseline values are stored as fractions
// (0.5) but must read as percentages in prose (50%). Pre-formatting here
// means the model copies a number we already computed - it never does the
// fraction-to-percent arithmetic itself (SPEC-BI-001 Section 9: the model
// performs no arithmetic).
const PERCENTAGE_RULES = new Set(['D-01', 'D-06', 'F-04', 'F-04c', 'F-03', 'F-05']);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// The exact structured payload handed to the model - also the source of
// truth the post-generation validator checks generated numbers against.
export function buildNarrationPayload(alert: DetectedAlertRow): Record<string, unknown> {
  const isPercentageRule = PERCENTAGE_RULES.has(alert.rule_code);
  const metricValue = Number(alert.metric_value);
  const baselineValue = alert.baseline_value === null ? null : Number(alert.baseline_value);

  return {
    rule: alert.rule_code,
    ruleDescription: RULE_DESCRIPTIONS[alert.rule_code] ?? alert.rule_code,
    dimension: alert.dimension,
    periodStart: alert.period_start,
    periodEnd: alert.period_end,
    baselineStart: alert.baseline_start,
    baselineEnd: alert.baseline_end,
    ...(isPercentageRule
      ? {
          metricValuePercent: round1(metricValue * 100),
          baselineValuePercent: baselineValue === null ? null : round1(baselineValue * 100),
        }
      : {
          metricValue,
          baselineValue,
        }),
    details: alert.details,
  };
}

// Every distinct number the model is allowed to write, including date
// components (so a written-out date like "September 16, 2026" isn't
// mistaken for an invented figure).
function collectAllowedNumbers(payload: Record<string, unknown>): Set<number> {
  const allowed = new Set<number>();

  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (value instanceof Date) {
      allowed.add(value.getUTCFullYear());
      allowed.add(value.getUTCMonth() + 1);
      allowed.add(value.getUTCDate());
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      allowed.add(value);
      allowed.add(round1(value));
      return;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && value.trim().length > 0) allowed.add(parsed);
      // A descriptive string (e.g. ruleDescription: "...the trailing 4-week
      // average") can carry numbers embedded in prose, not the whole field.
      // The model reasonably echoes these back, so they must count as
      // allowed too - otherwise validation fails unpredictably depending on
      // whether the model happens to write a window size etc. as a digit.
      for (const match of extractNumbers(value)) allowed.add(match);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };

  visit(payload);
  return allowed;
}

// Thousands-grouped numbers (e.g. "1,091") must be matched whole, before the
// plain-number alternative - otherwise a greedy single-digit-group match
// would read "1,091" as two separate numbers, 1 and 91, and the real value
// 1091 would never appear in either the narrative or the allowed set.
const NUMBER_PATTERN = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

function extractNumbers(text: string): number[] {
  const matches = text.match(NUMBER_PATTERN) ?? [];
  return matches.map((match) => Number(match.replace(/,/g, '')));
}

const MATCH_EPSILON = 0.05;

// SPEC-BI-001 Section 9: "A post-generation validation step must confirm that
// every numeric value in the generated text appears in the source payload.
// Mismatches block delivery and raise an alert."
export function findUnverifiedNumbers(narrative: string, payload: Record<string, unknown>): number[] {
  const allowed = [...collectAllowedNumbers(payload)];
  const found = extractNumbers(narrative);
  return found.filter((n) => !allowed.some((a) => Math.abs(a - n) <= MATCH_EPSILON));
}

const SYSTEM_PROMPT = `You are writing a one-paragraph alert summary for a daily business intelligence brief sent to a home-services company owner.

You will be given a rule finding with pre-computed numbers (metric value, baseline value, supporting counts). These numbers are already correct and final.

Rules:
- Use ONLY the numbers given to you. Never calculate, estimate, round differently, or invent any number not present in the input.
- Do not speculate about causes not evidenced in the data.
- Write 2-4 sentences, plain business language, no bullet points, no markdown.
- State what changed, by how much, and over what period.`;

export class AnthropicNarrationClient implements NarrationClient {
  private readonly client: Anthropic;

  public constructor(client: Anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })) {
    this.client = client;
  }

  public async narrate(alert: DetectedAlertRow): Promise<string> {
    const payload = buildNarrationPayload(alert);

    const response = await this.client.messages.create({
      model: env.NARRATE_MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }],
    });

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
    if (!textBlock || textBlock.text.trim().length === 0) {
      throw new Error(`Narrate: model returned no text for alert ${alert.id}`);
    }
    return textBlock.text.trim();
  }
}

export class NarrateService {
  public constructor(
    private readonly narrationClient: NarrationClient = new AnthropicNarrationClient(),
    private readonly database: Knex = db,
  ) {}

  // Narrates every detected_alerts row that doesn't have a narrative yet.
  // Failures on one alert (including a failed numeric validation) don't
  // block the others.
  //
  // `options.ids` restricts the run to specific row ids - production never
  // passes this (it must narrate every pending alert), but tests exercising
  // this method against a shared table must use it. A real incident showed
  // an unscoped run() narrating live production alerts with a jest mock's
  // placeholder text, because this method has no way to know which rows
  // "belong" to the caller otherwise - see tests/db-isolation.guard.test.ts
  // and the ids-filter usage in narrate.service.test.ts.
  public async run(options: { ids?: string[] } = {}): Promise<{ narrated: number; failed: number }> {
    let query = this.database('detected_alerts').whereNull('narrative');
    if (options.ids) query = query.whereIn('id', options.ids);
    const pending: DetectedAlertRow[] = await query.select('*');

    let narrated = 0;
    let failed = 0;
    for (const alert of pending) {
      try {
        const narrative = await this.narrationClient.narrate(alert);

        const unverified = findUnverifiedNumbers(narrative, buildNarrationPayload(alert));
        if (unverified.length > 0) throw new NarrativeValidationError(alert.id, unverified);

        await this.database('detected_alerts')
          .where({ id: alert.id })
          .update({ narrative, narrated_at: this.database.fn.now() });
        narrated += 1;
      } catch (error) {
        failed += 1;
        logger.error('[Narrate] Failed to narrate alert', {
          alertId: alert.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('[Narrate] Run completed', { narrated, failed });
    return { narrated, failed };
  }
}

export const narrateService = new NarrateService();
