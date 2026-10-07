# TruFinity BI Backend — Build Guide

> **Purpose of this file**: This is the single doc to paste into a **fresh Claude chat** whenever you want a new backend feature built (a new data source integration, a new Detect rule, a new reporting endpoint, etc.). It contains the full product context (condensed from `SPEC-BI-001`), the current implementation status, and — most importantly — the exact coding conventions this codebase already follows, so a new feature gets built consistent with everything that exists, without you having to re-explain the original spec or re-paste old code each time.
>
> **How to use it**: Paste this whole file into a new chat, then say what you want, e.g. *"Implement Dialpad call ingestion following this backend's conventions"* or *"Add rule F-04a (receivable with no collection contact) to the Detect layer."* That's it — no other context needed.

---

## 1. What this system is (condensed spec)

TruFinity (plumbing/HVAC/cooling, 5 Okanagan/Thompson markets) wants a **governed data warehouse with a deterministic exception-detection layer**, topped with an LLM used **only to narrate** numbers it did not calculate. The owner currently reconstructs business state manually from 6 apps; this system assembles it automatically every morning and flags exceptions.

**Strategic context that constrains design**: the business is being prepped for sale in ~24–36 months. Raw data must be stored **immutably, append-only, retained indefinitely**. Every derived metric must trace back to source records — no black-box calculations, ever.

### 1.1 The 5 layers (strict separation — this is the most important architectural rule)

1. **Extract** — scheduled, idempotent, retry-safe pulls from source systems. Failed extraction raises an alert, never fails silently.
2. **Store** — immutable raw landing zone (append-only) + modelled reporting tables. Full lineage from metric to source record.
3. **Detect** — deterministic rules engine (plain SQL). Thresholds must be owner-editable config, never hardcoded. **Zero AI involvement.**
4. **Narrate** — an LLM converts pre-computed exception output into ranked prose. It receives only numbers already computed elsewhere. **It never queries the warehouse, never does arithmetic, never rounds or adjusts a figure.** A post-generation validator must confirm every number in the LLM's output exists in the input payload; mismatches block delivery.
5. **Deliver** — daily email brief (06:30 PT) + mobile web view + drill-down dashboard. Read-only from the frontend's perspective.

**Non-negotiable**: a single hallucinated financial figure in month one destroys owner trust permanently. Any new code touching Narrate must preserve the validation step. Any new code touching Detect must be plain deterministic SQL — no LLM calls inside Detect, ever.

### 1.2 Data sources (tiered)

| Source | Tier | Notes |
|---|---|---|
| ServiceTitan | 1 | Jobs, invoices, estimates, job costing, technicians, memberships, dispatch, AR aging. Primary system of record. |
| QuickBooks Online | 1 | P&L, balance sheet, AP/AR, payroll cost. Financial truth — reconciles against ServiceTitan revenue. |
| Google Workspace Gmail | 1 | **Two distinct layers, different access scopes** — see 1.3. |
| Dialpad | 1 | Calls, recordings, AI transcripts/sentiment/moments, missed/abandoned events. Raw telephony source of truth. |
| Lace AI | 1 | Booking rate, objection categories, call outcome classification. **This system consumes Lace's computed values — it must never recompute booking rate from raw calls.** No public API; access is via a negotiated export (this codebase uses S3 CSV export). |
| Google Ads | 2 | Spend/clicks/conversions joined to booked ServiceTitan jobs and realized gross profit. |
| Google Business Profile | 2 | Reviews, ratings, per-location. |
| Other paid channels | 3 | Only after the Ads attribution join is proven. |

**Integration boundary (binding)**: Dialpad owns recording/transcription — never build a competing transcription pipeline. Lace owns booking-rate/objection classification — never recompute it. This system's unique value is: (a) classifying Dialpad transcripts for *customer distress* (different question than Lace's booking-outcome optimization), and (b) joining calls/clicks to downstream jobs, invoices, and gross profit — something neither Dialpad nor Lace can see.

### 1.3 Gmail — two layers, two access scopes (binding, technical not procedural)

| | Layer A — Responsiveness | Layer B — Escalation |
|---|---|---|
| Scope | Every company mailbox | Customer-facing mailboxes only (fixed, owner-approved list) |
| Data read | Metadata only (timestamps, sender, recipient, thread id, direction) | Full message content, classified then **discarded** — never stored |
| API scope | Must be technically metadata-only (not "promise not to read bodies") | Content scope, restricted to the approved mailbox list only |
| Feeds rules | R-01 to R-05 | E-01, E-04 |

Any Gmail work must preserve this split at the API-scope level, not just in application code.

### 1.4 Exception rules library (rule-ID namespace — use these exact codes)

- **F-series** (financial): F-01 GP$ below gate, F-02 margin drift, F-03 discount leakage, F-04/F-04a/F-04b/F-04c/F-04d (AR aging, no-contact, broken promise, concentration, credit memo), F-05 revenue reconciliation gap, F-06 zero/implausible material cost, F-07 negative-margin job.
- **O-series** (operational): O-01 unsold estimate aging, O-02 callback/warranty spike, O-03 capacity imbalance, O-04 membership lapse, O-05 technician outlier, O-06 job held open, O-07 repeat visit.
- **D-series** (demand/reputation): D-01 booking rate decline, D-02/D-02a abandoned calls/after-hours leakage, D-06 objection spike, D-04 review velocity, D-05 lead volume anomaly.
- **E-series** (customer escalation — **the core value of the whole system**): E-01 problem email, E-02 escalation on a call, E-03 negative review, E-04 unanswered inbound, E-05 silent-signal dissatisfaction (credit/refund/cancellation with no complaint on record — deterministic pattern matching, no LLM needed), E-06 escalation in tech notes, E-07 open escalation aging.
- **R-series** (team responsiveness, metadata-only): R-01 unanswered inbound, R-02 stalled thread, R-03 reply latency outlier, R-04 after-hours backlog, R-05 aging inbound queue.
- **M-series** (marketing): M-01 cost/booked job ceiling, M-02 spend with no bookings, M-03 GP/ad-dollar floor, M-04 impression share lost, M-05 pacing, M-06 **attribution integrity floor — governs all other M-series numbers; below floor, suppress return figures entirely, never estimate**, M-07 cost trend.
- **P-series** (opportunity, informational only): P-01 aging equipment, P-02 repeat-repair, P-03 non-member with history, P-04 missed cross-department, P-05 estimate without options.

Every rule has an owner-editable **severity** (RED/AMBER/BLUE) and threshold, and routes to a named accountable person with ack/resolve SLAs (spec Section 8) — not yet built (see Section 3).

### 1.5 Language model usage rules (Section 9 — binding for any Narrate work)

- Receives a structured payload of pre-computed metrics only. No database access.
- Performs no arithmetic. Every number in output must match the input payload character-for-character (within float tolerance).
- Post-generation validation blocks delivery on any unverified number.
- May rank, group, phrase — may not add context, speculate on cause, or invent recommendations.
- Every generated narrative stored with its input payload for audit.
- Model/hosting choice and data-residency must be documented (this codebase uses Anthropic Claude — see Section 2).

---

## 2. Current implementation status (as of this writing)

**Stack**: Node.js + TypeScript (strict) + Express 5 + PostgreSQL via `pg` + Knex (migrations & query building) + Zod (env validation) + Winston/Morgan (logging) + Jest/Supertest (tests) + ESLint/Prettier. LLM: `@anthropic-ai/sdk` (Claude). S3: `@aws-sdk/client-s3`. Gmail: `googleapis`. Cron: `node-cron`.

| Layer / Source | Status |
|---|---|
| ServiceTitan raw ingestion | ✅ Done — 8 entities (Customers, Locations, Jobs, Appointments, Leads, Bookings, Invoices, Payments, Technicians), tested |
| QuickBooks Online | ✅ Most mature — durable OAuth, raw ingestion, CDC pipeline, unified mapping layer |
| ServiceTitan↔QBO identity resolution | ✅ Done |
| Gmail | 🟡 Partial — raw ingestion + the Layer A/B mailbox-scope split exists at the schema level (`content_mode` check constraint). No responsiveness metrics or content-classification logic built on top yet. |
| Lace AI | ✅ Built — S3 CSV export ingestion, raw + canonical layers. Call-analysis entity confirmed working; agent-performance entity coded but no real file has landed yet. |
| Dialpad | ❌ Not started — no code, no dependency, no migration |
| Detect (rules engine) | 🟡 Early — only **D-01** and **D-06** implemented, as plain deterministic SQL (correct architecture). Thresholds are env-var defaults, not an owner-editable config table yet. |
| Narrate | ✅ Solid — Anthropic Claude, system prompt forbids arithmetic, real post-generation number-validator blocks mismatched output. This is the piece most worth copying the pattern from. |
| Deliver | 🟡 Stub — read-only `detected_alerts` query API only. No email sending, no brief composition, no 06:30 scheduler. |
| Reporting (QBO financial KPIs for dashboard) | ✅ Done — invoice/payment summaries, sync completeness, identity quality, payment-application integrity |
| Dashboard/frontend | Not in this repo (separate frontend project) |

---

## 3. Directory structure & module conventions

```
src/
  config/env.ts          # Zod-validated environment config — ALL env vars go through here, never process.env directly in modules
  database/               # Knex instance + knexfile
  middleware/              # error.middleware.ts (centralized), dev-only.middleware.ts
  modules/
    <source>/              # one folder per integration or business domain
      api.client.ts         # thin HTTP client for the external API (if any)
      auth.service.ts        # OAuth/token persistence (if the source needs it)
      <entity>.types.ts       # or types.ts — TS interfaces for that module
      ingestion/               # raw-layer pulls, one file per entity, e.g. invoice.ingestion.ts
      mapping/                  # raw -> canonical/unified projection + mappers
      canonical/                 # canonical-layer upsert services (Lace pattern) OR
      services/                   # read/query services (QuickBooks pattern) — naming varies slightly by module, follow the closest existing sibling
      <module>.routes.ts           # Express router, mounted in src/app.ts
      <module>.scheduler.ts         # node-cron wiring if the module runs on a schedule
      worker/ or *.worker.ts          # standalone worker entrypoint if it runs as its own process (see qbo-cdc.worker.ts)
  workers/                # standalone worker entrypoints (referenced from package.json scripts)
  scripts/                 # one-off/manual scripts (e.g. google-discover-mailboxes)
  utils/                    # shared cross-module utilities — logger.ts, retry.ts, advisory-lock.ts, sync-run.repository.ts/constants.ts
migrations/                 # Knex migrations, numbered NNN_description, one logical layer per file
tests/                       # mirrors src/modules structure exactly, one test file per source file
```

### 3.1 Raw-ingestion conventions (apply to ANY new source — ServiceTitan/Lace pattern)

- Raw tables are **append-only**. Never `UPDATE` or `DELETE` a raw row for a correction — insert a new row and flip `is_latest` (old row's `is_latest` -> false, new row's -> true).
- Every raw table has a `source_id`, `is_latest`, `is_deleted` (if the source supports deletes), a link to a `sync_runs` row, and stores the provider payload unchanged as `jsonb`.
- Use `src/utils/sync-run.repository.ts`'s `BaseSyncRunRepository` (extend it) for sync-run bookkeeping — don't hand-roll `sync_runs` inserts.
- Use `src/utils/advisory-lock.ts`'s `withAdvisoryLock` to prevent concurrent runs of the same ingestion — one Postgres advisory lock key per source+entity.
- Use `src/utils/retry.ts` for transient API-call retries.
- Interrupted runs (process crash mid-sync) must be recoverable — mark stale `RUNNING` rows `FAILED` on next startup (`recoverInterruptedRuns`/equivalent).
- Invalid/unparseable records go to a `sync_errors` table, never silently dropped, never a thrown exception that kills the whole batch.
- **Never log credentials, tokens, API keys, authorization codes, or raw provider response bodies.**

### 3.2 Canonical / unified layer conventions

- Raw → canonical/unified is a **separate mapping step**, not done inline during ingestion. See `mapping/` (QuickBooks) or `canonical/` (Lace) folders — a `*.mapper.ts` (pure function, raw row in, typed projection or a `{kind: 'mapped'|'deleted'|'skipped', ...}` result out) plus a `*.service.ts` that batches and persists.
- Money fields are `decimal(15,2)` columns, surfaced as **decimal strings** in TypeScript, never `number`/float. See `financial-business-rules.ts`'s `parseCents`/`formatCents` pattern (bigint-cents arithmetic) if any new code needs to do money math — never use JS floating point for money.
- Identity resolution across sources (e.g. ServiceTitan customer ↔ QuickBooks customer) goes through the `identity_mappings` table (see `src/modules/identity/`), not ad-hoc joins.

### 3.3 Detect (rules engine) conventions

- One file per rule under `src/modules/detect/rules/`, named `<rule-code-lowercase>-<short-name>.rule.ts` (e.g. `d01-booking-rate-decline.rule.ts`).
- Each rule is a plain function running deterministic SQL/Knex against canonical/unified tables — **no AI/LLM calls inside a rule**.
- Thresholds are read from `env` (config/env.ts) today — when you build a new rule, follow the same pattern *but flag in your response* that this should eventually move to an owner-editable DB config table (spec Section 5 intro) rather than env vars; don't block the rule on that migration existing yet unless asked to build it.
- Rule output is written to the shared `detected_alerts` table (see migration `010_detect_layer`) — one row per rule/dimension/period, with `metric_value`, `baseline_value`, `details` (jsonb), not a per-rule custom table.
- `detect.service.ts` is the orchestrator that runs registered rules — register new rules there.

### 3.4 Narrate conventions (preserve this pattern exactly for any new rule feeding Narrate)

- `narrate.service.ts` builds a numeric payload from a `detected_alerts` row (`buildNarrationPayload`), calls Claude with a system prompt that explicitly forbids arithmetic, then validates: every number extracted from the LLM's output text must appear in the source payload (`collectAllowedNumbers` + `findUnverifiedNumbers`, epsilon-tolerant match). On mismatch, throw and do **not** persist the narrative — the alert stays without prose rather than risking a wrong number.
- Model/config via env (`ANTHROPIC_API_KEY`, `NARRATE_MODEL`).
- New rule types automatically flow through Narrate as long as their `detected_alerts` row has the numeric fields the payload builder expects — extend `buildNarrationPayload` if a new rule's `details` shape needs new fields surfaced.

### 3.5 API/routes conventions

- One `<module>.routes.ts` file per module, `Router()` from Express, mounted in `src/app.ts` under `/api/<area>/<module>`.
- Every route uses the same envelope: `{ status: 'success', data: ... }` on success and `{ status: 'error', message: '...' }` on failure (quickbooks, reporting and deliver/alerts all follow it). Keep new routes on this shape — the frontend depends on it. (Dev-only gating middleware still returns a bare `{ error }` 403; that's the one known exception.)
- Dev-only diagnostic routes (that hit a live third-party API directly rather than the warehouse) are gated behind `devOnly` middleware (`src/middleware/dev-only.middleware.ts`) and must never be treated as the production data path for a dashboard.
- Read-only is a hard rule for all source-system integrations (ServiceTitan, QuickBooks) — **never add a write/POST-to-source-system endpoint**, no exceptions, per spec Section 2.2 and Section 11.

### 3.6 Testing conventions

- `tests/` mirrors `src/modules/` 1:1 — one test file per source file, same relative path.
- Tests hit a real test Postgres database via the same `db` Knex instance (see `tests/deliver/deliver.service.test.ts` for the pattern: insert fixture rows with a future/sentinel date range, clean up in `beforeEach`, assert against filtered results).
- Cover: idempotency (re-running ingestion doesn't duplicate), stale-run recovery, error-path (`sync_errors`), and for Detect rules — the actual threshold-crossing logic with above/below-threshold fixtures.

### 3.7 Environment variables

- Every new env var goes through `src/config/env.ts`'s Zod schema — add validation there (required in production, optional with a safe default in development), never read `process.env.X` directly in a module.
- Document it in `.env.example` with a comment explaining what it's for.

---

## 4. What's explicitly NOT built yet (don't assume these exist)

- Dialpad integration (any part — auth, ingestion, webhooks).
- Gmail Layer A responsiveness metrics and Layer B content classification (raw ingestion exists; the metric/classification logic on top does not).
- Google Ads / Google Business Profile integrations.
- F-series (beyond basic invoice PAID/UNPAID classification), O-series, E-series, R-series, M-series, P-series Detect rules.
- Owner-editable threshold config table (thresholds are env vars today).
- Action routing / SLA accountability tracking (spec Section 8) — no `alert_owners`/ack/resolve tables.
- Daily brief composition, email delivery, or the 06:30 PT scheduler.
- Any UI/dashboard (separate frontend repo — see `FRONTEND_BUILD_GUIDE.md` if present).

If a requested feature depends on one of these not existing yet, say so up front and propose the minimal slice that's actually buildable now, rather than silently stubbing the missing piece.

---

## 5. Known open risks from the spec (surface these if a new feature touches them)

- **Lace AI has no public API** — this codebase already resolved this via S3 CSV export (see `src/modules/lace/s3.client.ts`). Any Lace-adjacent work should extend that pattern, not attempt a different access method without asking.
- **Dialpad specifics to account for** (per spec Section 6.2): transcripts are retrieved per-call by call ID, not in bulk exports; recording URLs need the `recordings` OAuth scope (API keys OK for testing only); scheduled stats exports are scoped per Dialpad Office (5 markets = 5 export configs); webhooks can fail delivery — retry + reconciliation sweep required; transcription must be explicitly enabled per line for AI events to exist at all.
- **Classification accuracy targets** (spec Section 6.4, binding acceptance criteria for any email/call classification work): under 5% false negatives, under 15% false positives at launch (10% after tuning), typically fewer than 5 escalation items/day, and a required "not a problem" feedback loop. Validate against 90 days of historical data before treating any classifier as launch-ready.
- **M-06 governs all marketing numbers** — if you ever build M-series, attribution-integrity-below-floor must suppress return figures entirely, never display a caveated estimate.

---

## 6. How to ask for a new feature using this file

Paste this file into a new chat, then state the feature plainly, e.g.:

- *"Implement Dialpad call ingestion (raw layer only) following this backend's conventions."*
- *"Add Detect rule F-06 (zero/implausible material cost on completed job) — deterministic SQL against unified_invoices, following the D-01 rule's file structure."*
- *"Build the Gmail Layer A responsiveness metrics (R-01 unanswered inbound) on top of the existing raw_gmail_messages table."*

No need to paste the original `SPEC-BI-001` document or explain the architecture again — it's all here. If the requested feature needs a decision the spec leaves open (e.g. exact threshold values, which are owner-configurable), ask rather than guessing a number.
