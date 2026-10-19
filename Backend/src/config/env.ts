import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { sanitizeApprovedMailboxAllowlist } from '../modules/google/gmail-policy';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  // Fails closed: an unset NODE_ENV runs as production, so dev-only routes stay
  // shut and production config checks apply. Local dev sets
  // NODE_ENV=development explicitly in .env (see .env.example).
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
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
  // Single dashboard client identity. This is compared only with the
  // server-authenticated session user; request-supplied identity is ignored.
  GOOGLE_DASHBOARD_ALLOWED_EMAILS: z.string().trim().pipe(z.email()),

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
  // The one QuickBooks company (realmId) this deployment may connect to. When
  // set, the OAuth callback rejects any other company; when empty, it only
  // accepts the company that is already connected (or any, if none is yet).
  QBO_REALM_ID: z.string().default(''),
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
  // Who is emailed when a data feed fails or goes stale (SPEC-BI-001 Layer 1:
  // failed extraction must raise an alert). Empty = ERROR log only.
  PIPELINE_ALERT_RECIPIENT: z.preprocess((v) => v === '' ? undefined : v, z.string().email().optional()),
  // Maximum SMTP delivery attempts per work-item notification before giving up.
  // Rows at or above this count are excluded from recoverPendingNotifications().
  WORK_ITEM_NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
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
  // Max allowed gap (percentage points) between our booking rate (Lace's
  // booked/qualified applied to call-level data) and the Success Ratio Lace
  // reports per CSR per month before it's logged as a mismatch. Lace rounds to
  // whole percents, so this must stay above ~1. Starting value - owner to confirm.
  LACE_BOOKING_RATE_RECONCILIATION_TOLERANCE_POINTS: z.coerce.number().min(0).default(3),
  // Dedicated Google Workspace inbox Lace AI emails its Monthly Agent
  // Performance Report to. When set, a daily job pulls the CSV attachments of
  // matching messages (LACE_REPORT_GMAIL_QUERY) via the service account - read
  // only, this one mailbox only, attachments only. Empty disables it.
  LACE_REPORT_MAILBOX: z.string().default(''),
  LACE_REPORT_MAILBOX_CRON: z.string().default('30 3 * * *'),
  LACE_REPORT_GMAIL_QUERY: z.string().default('subject:"Monthly Agent Performance Report" has:attachment filename:csv newer_than:180d'),
  // Lace feed health (lace-freshness.ts). A feed is STALE when no new Lace
  // file has arrived within this window: call analysis is a daily export,
  // agent performance a monthly report. Starting values - owner to confirm.
  LACE_CALL_ANALYSIS_MAX_AGE_HOURS: z.coerce.number().int().min(1).default(36),
  LACE_AGENT_PERFORMANCE_MAX_AGE_DAYS: z.coerce.number().int().min(1).default(45),
  // When the health check runs (besides after every Lace sync). Server time.
  LACE_FRESHNESS_CHECK_CRON: z.string().default('0 6 * * *'),

  // ServiceTitan: previously had no automated scheduler at all - ingestion
  // only ran from dev-only routes (403 outside NODE_ENV=development) or a
  // manual POST trigger, so production never synced. Default: daily at 01:00
  // for the 9 regular entities. Business Units are a small, mostly-static
  // settings list, so they sync far less often (weekly, Sunday 01:30).
  SERVICETITAN_SYNC_CRON: z.string().default('0 1 * * *'),
  SERVICETITAN_BUSINESS_UNIT_SYNC_CRON: z.string().default('30 1 * * 0'),
  // Telecom calls incremental sync: every 4 hours keeps call data fresh for
  // analysis while each run fetches only the delta since the last checkpoint.
  // The historical run must complete before this is enabled (see activation plan).
  SERVICETITAN_TELECOM_CALLS_SYNC_CRON: z.string().default('0 */4 * * *'),
  // Kill-switch for the Telecom incremental scheduler. Defaults to false so the
  // cron task is NOT registered at startup — it must be explicitly enabled in the
  // server's environment after the historical ingestion has been verified complete.
  // Activation sequence: set to true in .env, then restart the process.
  SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SERVICETITAN_STUCK_RUN_REAPER_CRON: z.string().default('*/30 * * * *'),
  SERVICETITAN_STUCK_RUN_THRESHOLD_MINUTES: z.coerce.number().default(60),
  // Telecom calls initial sync window. Used ONLY on the very first run when no
  // saved continuation token exists. Default is 90 days — enough for initial
  // validation without triggering a full historical export of 86k+ records.
  // Must be a valid ISO 8601 date string (YYYY-MM-DD or full datetime).
  // Once a continuation token is saved this value is never consulted again.
  // Production deployments MUST explicitly set this to their intended historical
  // start date before initial synchronization. The default (2026-07-10) is safe
  // for staging validation only and covers approximately 90 days.
  SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM: z
    .string()
    // Full anchor: reject partial matches and unexpected suffixes
    .regex(
      /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
      'SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM must be YYYY-MM-DD with valid month (01-12) and day (01-31)',
    )
    // Reject impossible calendar dates (e.g. 2026-02-30).
    // new Date('2026-02-30') rolls over to March 2 rather than returning NaN, so
    // a plain isNaN check is insufficient. The round-trip check
    // (re-serialise and compare) catches overflow dates in any timezone because
    // Date always normalises to UTC midnight for YYYY-MM-DD strings.
    .refine(
      (v) => new Date(v).toISOString().slice(0, 10) === v,
      'SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM is not a valid calendar date',
    )
    // Reject future dates — a future start date would skip current data entirely
    .refine(
      (v) => new Date(v) <= new Date(),
      'SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM must not be a future date',
    )
    .default('2026-07-10'),

  // V3 Telecom enrichment — separate scheduler from V2 Export.
  // Cron: every 6 hours (offset from V2 to avoid simultaneous API load).
  // Kill-switch: defaults to false — must be explicitly enabled after the V3
  // historical backfill has completed and been verified.
  SERVICETITAN_TELECOM_V3_SYNC_CRON: z.string().default('0 2,8,14,20 * * *'),
  SERVICETITAN_TELECOM_V3_SYNC_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Overlap window for incremental modifiedOnOrAfter queries.
  // The saved checkpoint is shifted back by this many minutes on each incremental
  // run to catch records with equal modification timestamps or delayed API visibility
  // at the boundary of the previous run. Upserts are idempotent so re-fetching
  // these records is safe. 5 minutes is a conservative default.
  SERVICETITAN_TELECOM_V3_OVERLAP_MINUTES: z.coerce.number().int().min(0).max(60).default(5),
  // Coverage gap warning threshold: log a warning when more than this many V2 calls
  // within the V3 historical window are missing a V3 enrichment record.
  // 0 disables the threshold check (all gaps are still logged at info level).
  SERVICETITAN_TELECOM_V3_COVERAGE_GAP_WARN_THRESHOLD: z.coerce.number().int().min(0).default(10),

  // On startup, run any ServiceTitan entity sync whose last success is older
  // than this (Business Units: 8 days) - catches up crons missed while the
  // process was down. One entity at a time, after a short delay.
  SERVICETITAN_CATCH_UP_ON_STARTUP: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  SERVICETITAN_CATCH_UP_AFTER_HOURS: z.coerce.number().int().min(1).default(26),

  // Detect layer thresholds (SPEC-BI-001 exact values not confirmed yet -
  // these are reasonable defaults, deliberately env-tunable so they can be
  // corrected without a code change once the spec's exact numbers are known).
  // D-01 (RED, SPEC-BI-001 5.3): alert when the Lace booking rate over the
  // rolling 7 days falls below this percentage, overall or for any CSR.
  DETECT_D01_BOOKING_RATE_FLOOR_PERCENT: z.coerce.number().default(60),
  // D-06: alert when an objection category's current 7-day count is at least
  // this many times its trailing 4-week weekly average (min sample size below).
  DETECT_D06_OBJECTION_SPIKE_MULTIPLIER: z.coerce.number().default(2),
  DETECT_D06_OBJECTION_MIN_SAMPLE: z.coerce.number().default(3),
  // F-04 (AMBER, SPEC-BI-001 5.1): alert on any open balance (QuickBooks or
  // ServiceTitan) that crossed the 30/60/90-day past-due bracket during the
  // window, OR when total QuickBooks AR grew at least this many percent over
  // the trailing 7 days.
  DETECT_F04_AR_GROWTH_THRESHOLD_PERCENT: z.coerce.number().default(15),
  // F-03 (AMBER, SPEC-BI-001 5.1): alert when discounts as a percentage of
  // gross revenue on QuickBooks invoices issued in the current week exceed
  // this percentage. Min invoice count guards against a one-invoice week.
  DETECT_F03_DISCOUNT_RATE_THRESHOLD_PERCENT: z.coerce.number().default(5),
  DETECT_F03_DISCOUNT_MIN_SAMPLE: z.coerce.number().default(5),
  // F-04c (AMBER, SPEC-BI-001 5.1): alert on any single customer whose
  // outstanding QuickBooks balance is above this dollar amount, OR when the
  // top five customer balances together exceed this share of total AR (only
  // once total AR is at least the min outstanding).
  DETECT_F04C_SINGLE_BALANCE_THRESHOLD: z.coerce.number().default(10000),
  DETECT_F04C_TOP5_SHARE_THRESHOLD_PERCENT: z.coerce.number().default(50),
  DETECT_F04C_AR_MIN_OUTSTANDING: z.coerce.number().default(1000),
  // F-04d (RED, SPEC-BI-001 5.1): alert on any single credit memo, invoice
  // adjustment, or invoice-total reduction at or above this dollar amount.
  DETECT_F04D_MIN_AMOUNT: z.coerce.number().default(250),
  // F-05: alert when ServiceTitan's and QuickBooks' recorded revenue for
  // invoices issued in the current 7-day window diverge by at least this
  // many percentage points (of ServiceTitan's total) - ServiceTitan is the
  // operational system of record, QuickBooks is supposed to reconcile
  // against it, so a persistent gap signals a sync/booking problem.
  DETECT_F05_REVENUE_GAP_THRESHOLD_POINTS: z.coerce.number().default(10),
  DETECT_F05_MIN_REVENUE: z.coerce.number().default(1000),
  // O-series thresholds follow SPEC-BI-001 Section 5.2 trigger conditions;
  // the values themselves are starting points pending owner confirmation.
  // O-02 (RED): alert when a department's (ServiceTitan business unit) or
  // technician's callback rate - recall (recallForId) or warranty
  // (warrantyId) jobs - in the current 7 days rises at least this many
  // percentage points above its own trailing 4-week rate. Each department/
  // technician needs at least the min sample of jobs in both windows.
  DETECT_O02_CALLBACK_RATE_INCREASE_THRESHOLD_POINTS: z.coerce.number().default(5),
  DETECT_O02_MIN_SAMPLE: z.coerce.number().default(10),
  // O-05 (AMBER): alert when a technician's average ticket on jobs completed
  // in the current 7 days is more than this many percent above OR below the
  // rest of the team's average. Technicians with fewer completed sold jobs
  // than the min sample are skipped; needs at least MIN_TECHNICIANS qualifying.
  DETECT_O05_AVG_TICKET_BAND_PERCENT: z.coerce.number().default(40),
  DETECT_O05_MIN_JOBS_PER_TECHNICIAN: z.coerce.number().default(3),
  DETECT_O05_MIN_TECHNICIANS: z.coerce.number().default(3),
  // O-06 (AMBER): alert on each ServiceTitan job completed in the field at
  // least this many days ago whose invoice is still not posted (missing, or
  // syncStatus 'Pending'). Jobs completed before the lookback are ignored so
  // an old backlog doesn't flood the brief on first run.
  DETECT_O06_NOT_INVOICED_DAYS: z.coerce.number().default(3),
  DETECT_O06_LOOKBACK_DAYS: z.coerce.number().default(90),
  // O-07 (AMBER): alert on each new ServiceTitan job at the same location
  // (address) as another job completed within this many days before it - on
  // the same equipment when both jobs carry equipment ids.
  DETECT_O07_REPEAT_WINDOW_DAYS: z.coerce.number().default(30),

  // D-02: Daily Abandoned Call Threshold Detection (ServiceTitan Telecom)
  // Fires a RED alert for each local calendar day on which the count of
  // ServiceTitan-classified Inbound Abandoned calls strictly exceeds the
  // configured daily threshold (count > threshold, not >=).
  //
  // ⚠ PRODUCT CONFIRMATION REQUIRED before activation:
  //   - DETECT_D02_DAILY_THRESHOLD: 0 disables alert generation even when enabled;
  //     must be confirmed with Daniel. No default invented.
  //   - DETECT_D02_TIMEZONE: must match the business's operating timezone.
  //
  // Scope: covers only ST-classified "Abandoned" calls — callers who entered the
  // phone system but disconnected before being answered. Ring-level missed calls
  // that never reached ServiceTitan require Dialpad integration and are NOT covered.
  //
  // Kill-switch defaults to false. Enable only after confirming threshold with Daniel.
  DETECT_D02_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // ⚠ Set to 0 (disabled) until Daniel confirms the daily threshold value.
  DETECT_D02_DAILY_THRESHOLD: z.coerce.number().int().min(0).default(0),
  DETECT_D02_TIMEZONE: z.string().default('America/Toronto').refine((tz) => {
    try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
  }, 'DETECT_D02_TIMEZONE must be a valid IANA timezone identifier'),
  // Minimum hours since a day ended before it is evaluated. Guards against a partial
  // day raising a false alert because the V3 sync has not yet ingested all calls.
  DETECT_D02_SYNC_BUFFER_HOURS: z.coerce.number().int().min(0).max(48).default(2),

  // D-02a: After-Hours Voicemail & Missing Callback Detection
  // ⚠ PRODUCT CONFIRMATION REQUIRED: TELECOM_D02A_THRESHOLD_MINUTES default (240 = 4 business hours)
  // is a provisional placeholder matching R-01. Client must confirm before production activation.
  // Kill-switch defaults to false — must be explicitly enabled after the migration has been applied
  // and the V3 enrichment sync has been verified complete for the lookback window.
  TELECOM_D02A_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TELECOM_D02A_THRESHOLD_MINUTES: z.coerce.number().int().min(1).max(10_080).default(240),
  TELECOM_D02A_TIMEZONE: z.string().default('America/Toronto').refine((tz) => {
    try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
  }, 'TELECOM_D02A_TIMEZONE must be a valid IANA timezone identifier'),
  TELECOM_D02A_BUSINESS_START_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  TELECOM_D02A_BUSINESS_END_HOUR: z.coerce.number().int().min(1).max(24).default(17),
  TELECOM_D02A_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(14),

  // R-01: Unanswered Inbound Email Detection (Google Workspace responsiveness rule)
  // ⚠ PRODUCT CONFIRMATION REQUIRED: GOOGLE_R01_THRESHOLD_MINUTES default (240 = 4 business hours)
  // was chosen as a conservative placeholder. The product team must confirm the exact threshold
  // before this rule is considered calibrated for production.
  // Timezone and business hours: Daniel confirmed Pacific Time, 8:00 AM–4:30 PM (2026-10-09).
  GOOGLE_R01_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  GOOGLE_R01_THRESHOLD_MINUTES: z.coerce.number().int().min(1).max(10_080).default(240),
  GOOGLE_R01_TIMEZONE: z.string().default('America/Los_Angeles'),
  GOOGLE_R01_BUSINESS_START_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  GOOGLE_R01_BUSINESS_END_HOUR: z.coerce.number().int().min(1).max(24).default(16),
  GOOGLE_R01_BUSINESS_END_MINUTE: z.coerce.number().int().min(0).max(59).default(30),
  GOOGLE_R01_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  GOOGLE_R01_EVAL_INTERVAL_MS: z.coerce.number().int().min(300_000).max(86_400_000).default(900_000),
  // Emergency classification — disabled until the v2 prompt and DB migration are deployed.
  // Requires: migration 20261015120000_023_emergency_classification_label.ts executed first.
  GOOGLE_R01_EMERGENCY_CLASSIFICATION_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Daniel confirmed: 25 minutes for confirmed emergencies.
  GOOGLE_R01_EMERGENCY_THRESHOLD_MINUTES: z.coerce.number().int().min(1).max(1440).default(25),
  // High bar: only act on high-confidence emergency detections.
  GOOGLE_R01_EMERGENCY_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  // Comma-separated prompt versions that include the 'emergency' label.
  // v1 and earlier did not emit 'emergency'; classifications from those versions are ignored.
  GOOGLE_R01_EMERGENCY_TRUSTED_PROMPT_VERSIONS: z.string().default('v2'),

  // R-02: Stalled Thread Detection
  // Condition A (inactivity) threshold is 24 coverage hours (Mon–Fri 8 AM–10 PM,
  // Sat–Sun 7 AM–10 PM, America/Los_Angeles — Daniel confirmed).
  // Condition B (excessive exchanges) fires independently once message_count >= threshold.
  GOOGLE_R02_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // ⚠ PRODUCT CONFIRMATION REQUIRED: elapsed vs business-hours interpretation unknown.
  GOOGLE_R02_CONDITION_A_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  GOOGLE_R02_INACTIVITY_THRESHOLD_MINUTES: z.coerce.number().int().min(1).max(10_080).default(1440),
  // Daniel confirmed: 24 coverage hours (Mon–Fri 8 AM–10 PM, Sat–Sun 7 AM–10 PM, Pacific).
  GOOGLE_R02_INACTIVITY_POLICY: z.enum(['ELAPSED', 'BUSINESS_HOURS']).default('BUSINESS_HOURS'),
  // Daniel confirmed three individual emails triggers escalation recommendation.
  GOOGLE_R02_MESSAGE_COUNT_THRESHOLD: z.coerce.number().int().min(2).max(100).default(3),
  GOOGLE_R02_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  GOOGLE_R02_EVAL_INTERVAL_MS: z.coerce.number().int().min(300_000).max(86_400_000).default(900_000),

  // R-03: Reply Latency Outlier
  // Measures how long the team takes to reply to inbound messages, per mailbox threshold.
  // Mailbox-specific thresholds (service@/support@: 240 min = 4 biz hours; others: 1 biz day)
  // are baked into the rule using the shared business calendar; no per-mailbox env var needed.
  GOOGLE_R03_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Default threshold in business minutes for personal/other mailboxes (1 business day = 8.5h * 60).
  // service@ and support@ override this to 240 in the rule.
  GOOGLE_R03_DEFAULT_THRESHOLD_MINUTES: z.coerce.number().int().min(1).max(10_080).default(510),
  GOOGLE_R03_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  GOOGLE_R03_EVAL_INTERVAL_MS: z.coerce.number().int().min(300_000).max(86_400_000).default(900_000),

  // R-04: After-Hours Backlog
  // Detects inbound messages received during configured after-hours coverage windows
  // that remain unanswered beyond graceMinutes after the next business opening.
  // After-hours windows (Mon–Fri 4:30–10 PM, Sat–Sun 7 AM–10 PM Pacific) are
  // baked into the rule; no per-window env var is needed.
  GOOGLE_R04_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Minutes of grace after the next business opening before an OPEN alert fires.
  // Daniel confirmed: 60 minutes (team must reply by 9:00 AM Pacific).
  GOOGLE_R04_GRACE_MINUTES: z.coerce.number().int().min(1).max(480).default(60),
  GOOGLE_R04_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  GOOGLE_R04_EVAL_INTERVAL_MS: z.coerce.number().int().min(300_000).max(86_400_000).default(900_000),

  // Responsiveness mailbox allowlist: comma-separated addresses. Only mailboxes
  // in this list are processed by the responsiveness worker. This is independent
  // of the DB-level enabled flag — it is a second gate for controlled backfill
  // and single-pass execution without touching production mailbox config.
  // Default: the three approved content mailboxes.
  GOOGLE_RESPONSIVENESS_MAILBOX_ALLOWLIST: z.string()
    .default('service@trufinity.ca,support@trufinity.ca,billing@trufinity.ca')
    .transform((v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),

  // Responsiveness notification delivery
  // DISABLED (default): no emails are sent. TEST: sends exclusively to
  // WORK_ITEM_NOTIFICATION_RECIPIENT. PRODUCTION: sends to the configured
  // recipient list; requires explicit gate string + Daniel's priority approval.
  //
  // WARNING: Do NOT set TEST to edrice@trufinity.ca or casey@trufinity.ca.
  //          The notifier hard-rejects a test recipient that overlaps production.
  //
  // Requires: migration 20261015130000_024_google_responsiveness_notifications.ts
  GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE: z.enum(['DISABLED', 'TEST', 'PRODUCTION']).default('DISABLED'),
  // Comma-separated recipient email addresses for PRODUCTION mode.
  GOOGLE_RESPONSIVENESS_NOTIFICATION_RECIPIENTS: z.string().default(''),
  // Must be set to the exact string 'I_CONFIRM_PRODUCTION_NOTIFICATIONS' to
  // enable PRODUCTION mode. Prevents accidental production delivery.
  GOOGLE_RESPONSIVENESS_NOTIFICATION_PRODUCTION_GATE: z.string().default(''),
  // Maximum delivery attempts per notification before marking FAILED.
  GOOGLE_RESPONSIVENESS_NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  // Lease window: SENDING rows older than this (minutes) are eligible for recovery.
  GOOGLE_RESPONSIVENESS_NOTIFICATION_LEASE_MINUTES: z.coerce.number().int().min(1).max(60).default(10),

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
