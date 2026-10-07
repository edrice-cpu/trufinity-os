import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { sanitizeApprovedMailboxAllowlist } from '../modules/google/gmail-policy';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default(3000),
  DB_HOST: z.string().min(1),
  DB_PORT: z.string().transform(Number).default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  // Number of reverse-proxy hops to trust for client IPs (0 disables proxy trust).
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

  // Authentication
  APP_BASE_URL: z.url().default('http://localhost:3001').transform((value) => value.replace(/\/+$/, '')),
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  AUTH_PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  AUTH_MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(50).default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  // Outbound email (SMTP) used for password reset messages
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().default('TruFinity <no-reply@trufinity.ca>'),

  // QuickBooks Online
  QBO_CLIENT_ID: z.string().default(''),
  QBO_CLIENT_SECRET: z.string().default(''),
  QBO_REDIRECT_URI: z.string().default(''),
  QBO_AUTH_URL: z.string().default(''),
  QBO_TOKEN_URL: z.string().default(''),
  QBO_REVOKE_URL: z.string().default('https://developer.api.intuit.com/v2/oauth2/tokens/revoke'),
  QBO_DISCONNECT_AUTH_TOKEN: z.string().default(''),
  QBO_API_BASE_URL: z.string().default(''),
  QBO_CDC_POLL_INTERVAL_MS: z.coerce.number().int().min(300_000).max(86_400_000).default(900_000),

  // Google Workspace / Gmail foundation. Credentials are optional until Phase B.
  GOOGLE_CLOUD_PROJECT_ID: z.string().default('trufinity-email-integration'),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().default(''),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().default('').transform((value) => value.replace(/\\n/g, '\n')),
  GOOGLE_ADMIN_DELEGATED_USER: z.string().default(''),
  GOOGLE_GMAIL_DELEGATED_USER: z.string().default(''),
  GOOGLE_GMAIL_HISTORICAL_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
  GOOGLE_GMAIL_SYNC_INTERVAL_MS: z.coerce.number().int().min(300_000).max(86_400_000).default(900_000),
  GOOGLE_GMAIL_APPROVED_CONTENT_MAILBOXES: z.string()
    .default('service@trufinity.ca,support@trufinity.ca,billing@trufinity.ca')
    .superRefine((value, context) => {
      try { sanitizeApprovedMailboxAllowlist(value); }
      catch { context.addIssue({ code: 'custom', message: 'Google Gmail approved content mailbox configuration is invalid.' }); }
    })
    .transform(sanitizeApprovedMailboxAllowlist),

  // Layer B classifier foundation. Disabled until provider/model/threshold are approved.
  GMAIL_CLASSIFIER_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  GMAIL_CLASSIFIER_PROVIDER: z.string().default('anthropic'),
  GMAIL_CLASSIFIER_MODEL: z.string().default(''),
  GMAIL_CLASSIFIER_CONFIDENCE_THRESHOLD: z.preprocess((value) => value === '' ? undefined : value, z.coerce.number().min(0).max(1).optional()),
  GMAIL_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  GMAIL_CLASSIFIER_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  GMAIL_CLASSIFIER_PROMPT_VERSION: z.string().default('v1'),
  WORK_ITEM_NOTIFICATION_RECIPIENT: z.preprocess((v) => v === '' ? undefined : v, z.string().email().optional()),
  // ServiceTitan
  SERVICETITAN_CLIENT_ID: z.string().default(''),
  SERVICETITAN_CLIENT_SECRET: z.string().default(''),
  SERVICETITAN_APP_KEY: z.string().default(''),
  SERVICETITAN_AUTH_URL: z.string().default(''),
  SERVICETITAN_BASE_URL: z.string().default(''),
  SERVICETITAN_TENANT_ID: z.string().default(''),
  // Where tenant admins grant this app access (Settings > Integrations > API Application Access).
  SERVICETITAN_CONNECT_URL: z.url().default('https://go.servicetitan.com'),

  // Lace AI (batch export via S3 - no public API, see Section 4.1 of SPEC-BI-001)
  LACE_S3_BUCKET: z.string().default(''),
  LACE_S3_REGION: z.string().default(''),
  LACE_S3_ACCESS_KEY_ID: z.string().default(''),
  LACE_S3_SECRET_ACCESS_KEY: z.string().default(''),
  LACE_S3_CALL_ANALYSIS_PREFIX: z.string().default(''),
  LACE_S3_AGENT_PERFORMANCE_PREFIX: z.string().default(''),
  // Cron expressions for the automated sync schedule. Defaults: Call Analysis
  // daily at 02:00, Agent Performance monthly on the 1st at 03:00 (server time).
  LACE_CALL_ANALYSIS_CRON: z.string().default('0 2 * * *'),
  LACE_AGENT_PERFORMANCE_CRON: z.string().default('0 3 1 * *'),
  // Stuck-run reaper: catches a sync_run left RUNNING by a crashed process
  // well before the next scheduled ingestion would notice on its own.
  LACE_STUCK_RUN_REAPER_CRON: z.string().default('*/30 * * * *'),
  LACE_STUCK_RUN_THRESHOLD_MINUTES: z.coerce.number().default(60),

  // ServiceTitan: previously had no automated scheduler at all - ingestion
  // only ran from dev-only routes (403 outside NODE_ENV=development) or a
  // manual POST trigger, so production never synced. Default: daily at 01:00
  // for the 9 regular entities. Business Units are a small, mostly-static
  // settings list, so they sync far less often (weekly, Sunday 01:30).
  SERVICETITAN_SYNC_CRON: z.string().default('0 1 * * *'),
  SERVICETITAN_BUSINESS_UNIT_SYNC_CRON: z.string().default('30 1 * * 0'),
  SERVICETITAN_STUCK_RUN_REAPER_CRON: z.string().default('*/30 * * * *'),
  SERVICETITAN_STUCK_RUN_THRESHOLD_MINUTES: z.coerce.number().default(60),

  // Detect layer thresholds (SPEC-BI-001 exact values not confirmed yet -
  // these are reasonable defaults, deliberately env-tunable so they can be
  // corrected without a code change once the spec's exact numbers are known).
  // D-01: alert when the current 7-day booking rate drops at least this many
  // percentage points below the trailing 4-week average booking rate.
  DETECT_D01_BOOKING_RATE_DROP_THRESHOLD_POINTS: z.coerce.number().default(10),
  // D-06: alert when an objection category's current 7-day count is at least
  // this many times its trailing 4-week weekly average (min sample size below).
  DETECT_D06_OBJECTION_SPIKE_MULTIPLIER: z.coerce.number().default(2),
  DETECT_D06_OBJECTION_MIN_SAMPLE: z.coerce.number().default(3),
  // F-04: alert when the share of invoices (QuickBooks or ServiceTitan) issued
  // in the current 7-day cohort that are now overdue-and-unpaid rises at least
  // this many percentage points above the trailing 4-week cohort average.
  DETECT_F04_AR_OVERDUE_RATE_INCREASE_THRESHOLD_POINTS: z.coerce.number().default(10),
  DETECT_F04_AR_MIN_SAMPLE: z.coerce.number().default(5),
  // F-03: alert when the aggregate discount-to-gross rate on QuickBooks
  // invoices issued in the current 7-day window rises at least this many
  // percentage points above the trailing 4-week average.
  DETECT_F03_DISCOUNT_RATE_INCREASE_THRESHOLD_POINTS: z.coerce.number().default(5),
  DETECT_F03_DISCOUNT_MIN_SAMPLE: z.coerce.number().default(5),
  // F-04c: alert when a single customer's outstanding QuickBooks AR balance
  // is at least this many percentage points of total outstanding AR. Only
  // evaluated once total outstanding AR is at least this dollar amount
  // (guards against a tiny AR book making one customer look "concentrated").
  DETECT_F04C_AR_CONCENTRATION_THRESHOLD_POINTS: z.coerce.number().default(25),
  DETECT_F04C_AR_MIN_OUTSTANDING: z.coerce.number().default(1000),
  // F-04d: alert when the current 7-day total QuickBooks credit-memo dollar
  // amount issued is at least this many times the trailing 4-week weekly
  // average (min sample count below avoids flagging a single small memo).
  DETECT_F04D_CREDITMEMO_SPIKE_MULTIPLIER: z.coerce.number().default(2),
  DETECT_F04D_CREDITMEMO_MIN_SAMPLE: z.coerce.number().default(3),
  // F-05: alert when ServiceTitan's and QuickBooks' recorded revenue for
  // invoices issued in the current 7-day window diverge by at least this
  // many percentage points (of ServiceTitan's total) - ServiceTitan is the
  // operational system of record, QuickBooks is supposed to reconcile
  // against it, so a persistent gap signals a sync/booking problem.
  DETECT_F05_REVENUE_GAP_THRESHOLD_POINTS: z.coerce.number().default(10),
  DETECT_F05_MIN_REVENUE: z.coerce.number().default(1000),

  // Narrate layer: LLM writes prose describing detected_alerts findings only -
  // it never recomputes numbers (SPEC-BI-001 Section 4.1).
  ANTHROPIC_API_KEY: z.string().default(''),
  NARRATE_MODEL: z.string().default('claude-opus-5'),
});

// A missing S3 secret must fail fast at startup in production, not surface
// later as a cryptic AWS SDK auth error the first time ingestion runs.
const productionEnvSchema = envSchema.superRefine((data, ctx) => {
  if (data.NODE_ENV !== 'production') return;
  if (data.LACE_S3_SECRET_ACCESS_KEY.length < 20) {
    ctx.addIssue({
      code: 'custom',
      path: ['LACE_S3_SECRET_ACCESS_KEY'],
      message: 'LACE_S3_SECRET_ACCESS_KEY is required (min 20 chars) when NODE_ENV=production.',
    });
  }
  if (data.LACE_S3_ACCESS_KEY_ID.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['LACE_S3_ACCESS_KEY_ID'],
      message: 'LACE_S3_ACCESS_KEY_ID is required when NODE_ENV=production.',
    });
  }
  if (data.LACE_S3_BUCKET.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['LACE_S3_BUCKET'], message: 'LACE_S3_BUCKET is required when NODE_ENV=production.' });
  }
});

const _env = productionEnvSchema.safeParse(process.env);

if (!_env.success) {
  console.error('? Invalid environment variables:', _env.error.format());
  process.exit(1);
}

// Hard guard: tests must never be able to connect to a non-test database.
// See tests/jest.setup-env.js, which forces DB_NAME onto an isolated DB
// before this file loads .env - this throw is the backstop if that override
// is ever bypassed or misconfigured.
//
// Checking NODE_ENV alone isn't enough: a real incident showed a test file
// writing a mock narrative onto live production alerts because it was run
// in a way that never set NODE_ENV=test in the first place (e.g. invoked
// directly, outside the npm test / jest.config.js entry point that loads
// tests/jest.setup-env.js via setupFiles) - so NODE_ENV stayed "development"
// and this guard never fired. JEST_WORKER_ID is set by Jest's own worker
// bootstrapping itself, before any user config (setupFiles, testEnvironment,
// a stray/alternate jest config) runs - it catches "this process is a Jest
// test run" regardless of whether our own NODE_ENV override executed.
const isTestRuntime = _env.data.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
if (isTestRuntime && !_env.data.DB_NAME.endsWith('_test')) {
  throw new Error(
    `Refusing to run under a test runner against database "${_env.data.DB_NAME}" - DB_NAME must end in "_test" ` +
    'to prevent tests from writing to a real database. See tests/jest.setup-env.js.',
  );
}

export const env = _env.data;
