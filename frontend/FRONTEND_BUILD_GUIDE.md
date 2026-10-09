# TruFinity BI Dashboard — Frontend Build Guide

> **Purpose of this file**: Hand this file to Claude (or a developer) on the frontend project. It explains what the product is (per `SPEC-BI-001`), what is already built in the UI, exactly which backend APIs exist today (with real request/response shapes), the frontend conventions to follow, and which parts of the UI are still placeholders.
>
> **Last synced with the code: 2026-10-08.** Section 8 explains how to keep it current.

---

## 1. What this product is

TruFinity is a plumbing/HVAC/cooling company operating across 5 Okanagan/Thompson markets (Kelowna, West Kelowna, Vernon, Penticton, Kamloops). This system replaces the owner manually checking 6 different apps every morning. It is **not a chatbot** — it's a governed data warehouse with:

- **Deterministic rules** that detect problems (financial, operational, customer-escalation, demand, marketing) against owner-editable thresholds.
- **An LLM used only to write prose** around numbers it did not calculate — it never computes, sums, or infers a figure.
- **A daily executive brief** (email + mobile web view) delivered every morning, plus a **drill-down dashboard** for on-demand detail.

The frontend **is the dashboard** (Section 2.1 of the spec: "a live web dashboard for on-demand drill-down into any flagged item") and, eventually, the mobile-readable web view of the daily brief (Section 7 of the spec).

### Non-negotiable design principle

Every number shown in the UI comes from a backend API, computed deterministically in the warehouse. **Never let the frontend calculate, sum, average, or derive a financial/operational figure client-side beyond display formatting (currency/date/percent formatting, rounding for display).** If a KPI is missing, ask for a new backend endpoint — do not compute it from raw rows in JS.

**Empty states over fake data**: a section without live data shows an honest "No data yet — pending backend integration" state. Never fabricate sample numbers.

---

## 2. Architecture context

Backend is Node.js/TypeScript + Express + PostgreSQL, structured in 5 layers:

1. **Extract** — pulls raw data from ServiceTitan, QuickBooks Online, Gmail, Lace AI (Dialpad not yet built).
2. **Store** — immutable raw tables + "unified"/"canonical" normalized tables in Postgres.
3. **Detect** — deterministic SQL rules engine, writes rows into a `detected_alerts` table. Rule IDs match the spec exactly (e.g. `D-01`, `F-04c`).
4. **Narrate** — an LLM (Anthropic Claude) turns a `detected_alerts` row into a short sentence stored on that same row (`narrative`). A validator guarantees every number in the sentence exists in the source data, so `narrative` is safe to render as plain text.
5. **Deliver** — a read-only API layer exposing what layers 3/4 produced.

Detect + Narrate run **automatically after each scheduled Lace AI sync** (`Backend/src/modules/lace/lace.scheduler.ts`). If `ANTHROPIC_API_KEY` isn't configured on the server, Narrate is skipped and `narrative` stays `null`.

**Two kinds of data, two API groups**: reporting KPIs (`/api/reporting/*`) and alerts/rule violations (`/api/brief/alerts`).

### How the frontend talks to the backend

- Next.js App Router (this repo uses a newer Next.js — read `node_modules/next/dist/docs/` before using framework APIs; e.g. `params`/`searchParams` are Promises).
- **All backend calls happen server-side** (Server Components / Server Actions). The browser never calls the backend directly, so API calls do **not** appear in the browser's Network tab — enable `logging.fetches` in `next.config.ts` to see them in the dev terminal.
- Backend base URL comes from the server-only env var **`BACKEND_API_URL`** (frontend `.env`, e.g. `http://localhost:4000`). In local dev the backend must not share the frontend's port (3000).

---

## 3. What exists in the UI today

Status legend: **✅ Live** = wired to a real API · **🚧 Placeholder** = page/section exists, shows the pending empty state.

| Route | What it shows | Status | API(s) |
|---|---|---|---|
| `/login`, `/forgot-password`, `/reset-password` | Sign-in and password reset | ✅ Live | `/api/auth/*` (4.12) |
| `/dashboard` | QuickBooks Financial Overview (invoices + payments, each with a date filter), Field Operations snapshot, "Needs your attention" (latest 4 open customer escalations), Demand Alerts (latest 3), quick links | ✅ Live | 4.2, 4.3, 4.8, 4.10, 4.14 |
| `/daily-brief` | Spec Section 7 shell, 9 sections in fixed order. **Data Freshness** (ServiceTitan sync status) and **Customer Escalations** (open email escalations, max 10) are live; the other 7 are placeholders | Partial | 4.8 (`sync-status`), 4.14 |
| `/demand-alerts` | D-series alerts with rule-code + date filters | ✅ Live | 4.10 |
| `/financial-alerts` | F-series alerts with rule-code + date filters | ✅ Live (UI ready; depends on alerts existing) | 4.10 |
| `/alerts/[id]` | Full alert record (any rule), formatted `details` | ✅ Live | 4.11 |
| `/field-operations` | ServiceTitan jobs (date + department filter), invoices, AR aging, payments, leads & bookings, appointments, customers, technician performance (confidential) | ✅ Live | 4.8, 4.9 |
| `/field-operations/jobs`, `/field-operations/invoices` | Paginated drill-down tables with status / classification filters | ✅ Live | 4.9 |
| `/data-quality` | QBO sync completeness, ST↔QBO customer identity match, payment-application integrity, ServiceTitan sync status | ✅ Live | 4.4–4.6, 4.8 |
| `/integrations` | QuickBooks / ServiceTitan connection status, QuickBooks connect | ✅ Live (requires login) | 4.13 |
| `/escalations`, `/escalations/[id]` | Customer escalations from email (classified work items): Escalations tab + separate Review queue tab, status/SLA filters, acknowledge / resolve / not-a-problem | ✅ Live (email only; requires login) | 4.14 |
| `/scorecard`, `/red-flags`, `/responsiveness`, `/marketing`, `/watchlist`, `/closed-loop` | Page layouts exist, data not available | 🚧 Placeholder | none yet (Section 5) |

### 3.1 Financial Overview (dashboard) — ✅ Live
Invoice KPIs (active invoices, invoice total, outstanding AR, tax, discount), invoice status breakdown (paid / partially paid / unpaid / zero value / unsupported / broken links), and payment tiles (count, total, applied, unapplied, reconciled / unreconciled, net reconciliation difference, payments without invoice link). Invoices and payments each have their **own date range picker** (default month-to-date).

### 3.2 Data Quality / Sync Health — ✅ Live
Admin/ops panel (spec Section 1.1 cares about audit-grade integrity because the business is being prepped for sale). Issue counters above zero are highlighted amber; zero is green.
- Customer Identity Match depends on the backend's ST↔QBO identity refresh having run (it runs inside the QBO CDC worker; a standalone `npm run identity:st-qbo-refresh` script also exists in the backend). If it never ran, every counter shows 0.

### 3.3 Demand Alerts — ✅ Live
D-01 (booking rate decline, tenant-wide or per CSR) and D-06 (objection-category spike). Each row: rule badge, label, dimension, narrative (or raw-value fallback + "Narrative pending"), metric vs. baseline, detected-at. Click-through to `/alerts/[id]`.

### 3.4 Financial Alerts — ✅ Live
F-03, F-04, F-04c, F-04d, F-05 (see the rule table in 6.4). Same row/detail components as Demand Alerts. Point-in-time rules (F-04c, F-05) have `baseline_value: null` — the UI hides the baseline instead of showing "—".

### 3.5 Field Operations (ServiceTitan) — ✅ Live
- **Jobs** card: date range + department filter (`Company` / `Service` / `New Construction`, omitted = all).
- Invoices, AR aging (5 buckets; 31–90 amber, 90+ red), payments by type, leads & bookings, appointments, customers.
- **"Completed, not invoiced"** = spec O-06; red when above zero.
- **Technician Performance is confidential** — see 6.7.
- Jobs/Invoices tables show `customerId` (the API has no customer name yet).

### 3.6 Daily Executive Brief — partially live
Fixed section order per spec Section 7 (do not reorder): Data Freshness → Scorecard → Customer Escalations (above financial red flags — this is the section the owner is "buying") → Red Flags (RED F/O exceptions ranked by dollar impact) → Responsiveness (counts/ages only, never message content) → Marketing → Watch List (AMBER, max 10) → Opportunities (BLUE with estimated revenue, max 5) → Closed Loop (resolved vs. open, age, owner, SLA). Sections are collapsible; each shows its pending state until its `sectionReady` flag is `true` (6.3).

### 3.7 Customer Escalations — ✅ Live (email source only)
- Source today: Gmail Layer B (customer-facing mailboxes), classified into complaint / billing dispute / cancellation intent / legal threat / damage claim / escalation request. Calls (Dialpad, E-02), reviews (E-03) and silent-signal cases (E-05) are not built yet — the page says so.
- **Escalations and the review queue are separate tabs** (`?work_type=REVIEW_REQUIRED` for the queue; default = escalations). Review-queue items are below the confidence floor and must never appear in the brief or in "Needs your attention" (spec 6.3).
- Filters (all in the URL, combinable, page resets to 1): `workflow_status` and `sla_state` chips, plus `mailbox_address` — a GET form (no client JS) or click any mailbox cell. The backend matches the mailbox exactly, so the page trims + lowercases it first (addresses are stored normalized).
- Each row shows: classification + confidence, workflow status, SLA (+ resolve-by), **customer** (`customerDisplayName`, falling back to the sender with "No customer match"), mailbox, classified-at.
- Actions (Server Actions in `app/(dashboard)/escalations/actions.ts`): **Ack** (claim), **Resolve** (note required, 1–2000 chars), **Not a problem** (one tap, spec 6.4 feedback loop — terminal). Acknowledge and resolve are tracked separately (spec 8.2).
- Detail page shows the one-line `reason`, customer, sender, deep link to Gmail (opens the first signed-in Google account — the page tells the user which mailbox to sign in as), deadlines, dismissal/resolution notes. **Message content is never shown** — the classification card says it was discarded.
- Still missing (backend): E-rule code per item, linked ServiceTitan job/invoice (spec 6.3).

---

## 4. API reference (what exists today)

**Envelope**: every endpoint below returns `{ "status": "success", "data": ... }`, or `{ "status": "error", "message": "..." }` with a non-2xx status. Exceptions: paginated lists (4.9) spread pagination fields at the top level, and auth endpoints (4.12) use `"status": "ok"`.

**Money** fields are **decimal strings** (`"12345.67"`) — format with `formatMoney`, never `parseFloat` (6.5). Counts are integers. Timestamps are ISO-8601 UTC.

**Date filter** (`?from=YYYY-MM-DD&to=YYYY-MM-DD`): where supported, omitted = **month-to-date** (1st of current month UTC → now). Either end can be given alone. ISO datetimes are also accepted.

### QuickBooks reporting — `/api/reporting/quickbooks`

#### 4.1 `GET /summary`
Everything in 4.2–4.6 in one call (invoices/payments here are **unfiltered**). Currently unused by the UI, which calls the individual endpoints so each card can have its own date filter.
```json
{ "status": "success", "data": {
  "invoices": {}, "payments": {}, "qboCompleteness": {},
  "customerIdentityQuality": {}, "paymentApplicationIntegrity": {}
} }
```

#### 4.2 `GET /invoices/summary` — date filter
```json
{ "status": "success", "data": {
  "totalActiveInvoices": 0, "paidCount": 0, "partiallyPaidCount": 0, "unpaidCount": 0,
  "zeroValueCount": 0, "unsupportedCount": 0,
  "invoiceTotal": "0.00", "outstandingAr": "0.00", "totalTax": "0.00", "totalDiscount": "0.00",
  "brokenTargetCount": 0
} }
```

#### 4.3 `GET /payments/summary` — date filter
```json
{ "status": "success", "data": {
  "paymentCount": 0, "paymentTotal": "0.00", "unappliedTotal": "0.00", "mappedApplicationTotal": "0.00",
  "reconciledPaymentCount": 0, "unreconciledPaymentCount": 0,
  "netReconciliationDifference": "0.00", "paymentsWithoutInvoiceApplications": 0
} }
```
`netReconciliationDifference` can be negative (`"-154324.40"`).

#### 4.4 `GET /completeness`
```json
{ "status": "success", "data": {
  "Customer": { "latestNonDeletedRawCount": 0, "activeIdentityCount": 0, "unifiedTargetCount": 0,
                "brokenTargetCount": 0, "duplicateSourceIdentityCount": 0, "mappingErrorCount": 0 },
  "Invoice": { "...": "same shape" },
  "Payment": { "...": "same shape" }
} }
```

#### 4.5 `GET /customer-identity-quality`
```json
{ "status": "success", "data": {
  "serviceTitanCustomerIdentityCount": 0, "verifiedTierACount": 0, "unresolvedCount": 0, "mergedCount": 0,
  "brokenUnifiedTargetCount": 0, "tierAWithoutSharedQboTarget": 0, "unresolvedSharingQboTarget": 0
} }
```

#### 4.6 `GET /payment-application-integrity`
```json
{ "status": "success", "data": {
  "totalApplicationRows": 0, "orphanPaymentReferences": 0, "orphanInvoiceReferences": 0,
  "duplicatePaymentInvoicePairs": 0, "applicationsWithInactiveOrDeletedQboIdentity": 0
} }
```

### ServiceTitan reporting — `/api/reporting/servicetitan`

#### 4.7 Summary endpoints

| Endpoint | Filters | `data` |
|---|---|---|
| `GET /summary` | — | `{ jobs, invoices, arAging, payments, leadsBookings, appointments, customers, technicians, syncStatus }` (shapes below). Memoized per request in the UI and shared by several cards. |
| `GET /jobs/summary` | date, `department` | `StJobsSummary` |
| `GET /invoices/summary` | — | `StInvoicesSummary` |
| `GET /invoices/ar-aging` | — | `StArAgingBucket[]` |
| `GET /payments/summary` | — | `StPaymentsSummary` |
| `GET /leads-bookings/summary` | — | `StLeadsBookingsSummary` |
| `GET /appointments/summary` | — | `StAppointmentsSummary` |
| `GET /customers/summary` | — | `StCustomersSummary` |
| `GET /technicians/summary` | — | `StTechnicianSummaryRow[]` — **confidential** (6.7) |
| `GET /sync-status` | — | `StSyncStatusRow[]` |

`department` must be exactly `Company`, `Service` or `New Construction`; anything else (or omitted) = all departments.

```ts
type CountByLabel = { label: string; count: number };

StJobsSummary = { totalJobs, completedJobs, completedLast30Days, createdLast30Days, noChargeJobs, recallJobs,
  completedNotInvoiced /* O-06 */, jobsTotalValue: money, byStatus: CountByLabel[] }
StInvoicesSummary = { totalActiveInvoices, paidCount, partiallyPaidCount, unpaidCount, invoiceTotal: money,
  outstandingBalance: money, totalDiscount: money, totalSalesTax: money, invoicedLast30Days: money, overdueCount }
StArAgingBucket = { bucket: "CURRENT" | "DAYS_1_30" | "DAYS_31_60" | "DAYS_61_90" | "DAYS_90_PLUS", invoiceCount, balance: money }
StPaymentsSummary = { paymentCount, paymentTotal: money, unappliedTotal: money, receivedLast30Days: money,
  byType: { label, count, total: money }[] }
StLeadsBookingsSummary = { totalLeads, leadsLast30Days, leadsByStatus: CountByLabel[], totalBookings,
  bookingsLast30Days, bookingsByStatus: CountByLabel[], bookingsConvertedToJob }
StAppointmentsSummary = { totalAppointments, upcomingAppointments, unconfirmedUpcoming, byStatus: CountByLabel[] }
StCustomersSummary = { totalCustomers, activeCustomers, customersWithBalance, totalCustomerBalance: money, createdLast30Days }
StTechnicianSummaryRow = { technicianId, name: string | null, active: boolean | null, jobsSold, jobsSoldValue: money }
StSyncStatusRow = { entityType, lastRunStatus: string | null, lastRunStartedAt, lastRunCompletedAt,
  lastRunRecordsProcessed: number | null, lastSuccessfulSyncAt, latestRawRecordCount }
```
(The authoritative TypeScript types are in `src/lib/api/servicetitan.ts`.)

#### 4.8 Where the UI uses them
`/summary` → Field Operations overview, dashboard snapshot, technician card · `/jobs/summary` → Jobs card (filtered) · `/sync-status` → Daily Brief Data Freshness + Data Quality.

#### 4.9 Paginated drill-downs
`GET /jobs?page=1&pageSize=25&status=<label>` · `GET /invoices?page=1&pageSize=25&classification=PAID|PARTIALLY_PAID|UNPAID|ZERO_VALUE`

`pageSize` max **100** (default 25). Invalid `classification` → `400`. Response (pagination spread at the top level, **not** inside `data`):
```json
{ "status": "success", "page": 1, "pageSize": 25, "totalCount": 1234, "data": [ /* rows */ ] }
```
```ts
StJobListItem = { id, jobNumber, status, customerId, locationId, soldById, total: money | null,
  createdOn, completedOn, invoiceId, noCharge: boolean, isRecall: boolean }
StInvoiceListItem = { id, referenceNumber, invoiceDate, dueDate, total: money | null, balance: money | null,
  customerId, jobId, paidOn, classification }
```

### Alerts — `/api/brief/alerts`

#### 4.10 `GET /api/brief/alerts?ruleCode=D-01&from=…&to=…`
`ruleCode` optional. Date filter applies to **`detected_at`** (default month-to-date). Newest first.
```json
{ "status": "success", "data": [ {
  "id": "uuid", "rule_code": "D-01", "dimension": "TENANT_TOTAL",
  "period_start": "2026-09-01T00:00:00.000Z", "period_end": "2026-09-08T00:00:00.000Z",
  "baseline_start": "2026-08-01T00:00:00.000Z", "baseline_end": "2026-08-08T00:00:00.000Z",
  "metric_value": "0.42", "baseline_value": "0.55",
  "details": { "...": "rule-specific JSON" },
  "narrative": "Booking rate fell to 42% this week, down from 55%...",
  "narrated_at": "2026-09-08T06:00:00.000Z", "detected_at": "2026-09-08T05:58:00.000Z"
} ] }
```
- `metric_value` / `baseline_value` are decimal strings; their meaning (fraction vs. dollars) depends on the rule — see the rule table (6.4).
- `baseline_value`, `baseline_start` and `baseline_end` can be `null` (point-in-time rules).
- `narrative` can be `null` (Narrate not run yet / failed validation / no API key) → render the raw values with a "Narrative pending" hint; never block the UI.

#### 4.11 `GET /api/brief/alerts/:id`
`{ "status": "success", "data": { /* one alert */ } }`, or `404 { "status": "error", "message": "Alert not found" }` (also for a malformed, non-UUID id).

### Auth — `/api/auth` (used by Server Actions only)

#### 4.12 Endpoints
| Endpoint | Body | Response |
|---|---|---|
| `POST /login` | `{ email, password }` | `200 { status: "ok", token, expiresAt, user: { id, email, fullName } }` |
| `POST /logout` | — (Bearer token) | `204` |
| `GET /me` | — (Bearer token) | `200 { status: "ok", user }`; `401` if the session is invalid |
| `POST /forgot-password` | `{ email }` | `202 { status: "ok", message }` — always the same message (no account enumeration); the email is sent asynchronously |
| `POST /reset-password` | `{ token, password }` | `200 { status: "ok", message }`; `400` if the token is invalid/expired |

- Sessions use `Authorization: Bearer <token>`. The frontend stores the token in an httpOnly cookie (`trufinity_session`, or `__Host-trufinity_session` in production) — see `src/lib/auth/session.ts`. The `(dashboard)` layout redirects to `/login` when `/me` fails.
- Login, forgot and reset are rate-limited. The reset link is `APP_BASE_URL/reset-password#token=<43 chars>`; the token sits in the URL fragment so it never reaches servers. It expires after `AUTH_PASSWORD_RESET_TTL_MINUTES` (default 30) and is single-use.
- **Reset emails need SMTP** on the backend (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`) and a correct `APP_BASE_URL` (default `http://localhost:3001` — wrong if the frontend runs on 3000). Without SMTP in development the link is only logged to the backend console; in production the send fails silently from the user's point of view.

#### 4.13 Integrations — `/api/integrations` (Bearer token required)
- `GET /status` → `{ status: "ok", quickbooks: { configured, connected, realmId, companyName, refreshTokenExpiresAt }, servicetitan: { configured, connected, tenantId, connectUrl } }`
- `POST /quickbooks/connect` → `{ status: "ok", authorizationUrl }`, or `503` if QuickBooks isn't configured on the server.

### Customer escalations (email work items) — `/api/google` (Bearer token required)

#### 4.14 Work items
Called through `backendFetch` with the session token (`src/lib/api/google.ts`); a `401` sends the user to `/login`. Unlike the other APIs, the list puts pagination **inside** `data`.

| Endpoint | Params / body | Response `data` |
|---|---|---|
| `GET /work-items/stats` | — | `{ totalOpen, escalation, reviewRequired, acknowledged, resolved, breached }` — `escalation` + `reviewRequired` split the open items; `acknowledged` / `resolved` / `breached` count **both** work types |
| `GET /work-items` | `work_type` (`ESCALATION` \| `REVIEW_REQUIRED`), `workflow_status` (`OPEN` \| `ACKNOWLEDGED` \| `RESOLVED` \| `CLOSED` \| `NOT_A_PROBLEM`), `sla_state` (`UNCONFIGURED` \| `ON_TRACK` \| `BREACHED` \| `MET`), `mailbox_address`, `page`, `pageSize` (max 100) | `{ items: WorkItem[], total, page, pageSize }`, newest `classifiedAt` first |
| `GET /work-items/:id` | — | `WorkItem`; `404` if missing / non-UUID |
| `POST /work-items/:id/acknowledge` | — | `WorkItem` (idempotent) |
| `POST /work-items/:id/resolve` | `{ resolution_note }` (1–2000 chars) | `WorkItem`; `400` with `errors[]` on validation |
| `POST /work-items/:id/not-a-problem` | `{ dismissal_reason? }` (≤ 500 chars) | `WorkItem`; `404` if missing or already terminal |

```ts
WorkItem = { id, workType, workflowStatus, slaState, mailboxAddress, providerMessageId,
  sourceUrl /* Gmail deep link, u/0 = first signed-in account */, routedOwnerReference: string | null,
  acknowledgementDeadline, resolutionDeadline, acknowledgedAt, resolvedAt, resolutionNote,
  dismissedAt, dismissedByUserId, dismissalReason,
  unifiedCustomerId, customerDisplayName /* null unless exactly one customer matched the sender email */,
  createdAt, updatedAt, classificationId, classificationLabel, confidence: number /* 0–1 */,
  reason /* one-line, safe to show */, decisionStatus, classifiedAt, senderFrom: string | null }
```
`RESOLVED`, `CLOSED` and `NOT_A_PROBLEM` are terminal — no actions are offered.

### Diagnostic-only endpoints — do NOT build UI against these
`/api/integrations/quickbooks/*` data routes (customers, invoices, payments, accounts, companyinfo), `/api/integrations/servicetitan/*`, `/api/detect`, `/api/narrate` are backend debugging routes (mostly `NODE_ENV=development` only). Use the warehouse reporting endpoints above instead.

---

## 5. What is NOT built yet (don't call these — they don't exist)

| Spec area | Rule series | Status |
|---|---|---|
| Customer escalation detection | E-01 to E-07 | **Email escalations are live as work items** (4.14), but without an E-rule code or linked ST job/invoice. Not built: calls (E-02, needs Dialpad), reviews (E-03), E-04 unanswered-message rule, silent signal (E-05), tech notes (E-06), escalation aging (E-07) |
| Team responsiveness (mailbox metadata) | R-01 to R-05 | Not built — Gmail raw ingestion exists, no metrics on top |
| Financial red flags | F-01, F-02, F-04a/b, F-06, F-07 (gross profit gates, margin drift, negative-margin jobs) | Not built. **Built:** F-03, F-04, F-04c, F-04d, F-05 (see 6.4) |
| Operational exceptions | O-01 to O-07 | Not built as alerts. O-06 is only shown as a KPI ("Completed, not invoiced") |
| Marketing performance | M-01 to M-07 | Not built — no Google Ads integration |
| Opportunity detection | P-01 to P-05 | Not built |
| Scorecard time series (yesterday / WTD / MTD vs. prior period) | Spec Section 7 | Not built — only current-snapshot KPIs exist |
| Daily brief email delivery (06:30 PT) | Spec Section 7 | Not built |
| Threshold configuration (owner-editable) | Spec Section 5 | Not built — thresholds are backend env vars. Will need an admin settings screen; reserve a nav slot |
| Action routing / SLA (owner, ack/resolve) | Spec Section 8 | Only on email work items (4.14: routed owner, ack/resolve deadlines, SLA state). Not built for alerts — Closed Loop stays a placeholder |
| User roles | — | Not built — `/me` returns no role (see 6.7) |
| Customer names on ST jobs/invoices lists | — | Not in API — tables show `customerId` |
| Dialpad call data | — | Not built |
| Lace AI booking-rate data → D-01/D-06 | — | ✅ Built (Lace S3 ingestion + scheduled Detect/Narrate) |

---

## 6. Frontend conventions (follow these)

### 6.1 Folder map
```
src/lib/api/client.ts         apiGet (envelope), apiGetPage (paginated), ApiError, BACKEND_API_URL
src/lib/api/reporting.ts      QuickBooks reporting types + fetchers
src/lib/api/servicetitan.ts   ServiceTitan reporting types + fetchers
src/lib/api/alerts.ts         DetectedAlert type, listAlerts, getAlert (404 → null)
src/lib/api/google.ts         email work items (escalations + review queue): list, stats, get — token required
src/lib/auth/                 session cookie, backendFetch, validation
src/lib/auth.ts               getViewerRole / canViewConfidential
src/lib/rules.ts              rule registry (single source of truth for rule codes)
src/lib/sections.ts           per-section "ready" flags
src/lib/filters.ts            date range / department URL params, presets
src/lib/format.ts             money, count, ratio, date, label formatters
src/lib/nav.ts                sidebar items
src/components/sections/      one component per section (FinancialOverview, DataQualityPanel, DemandAlerts, FinancialAlerts, OpenEscalations, servicetitan/*)
src/components/alerts/        AlertRow, RuleBadge, alertSummary
src/components/google/        WorkItemTable + filter tabs/chips, WorkItemBadges, WorkItemActions (ack / resolve / not a problem)
src/components/ui/            Card, StatCard, States (Empty/Error/Pending/Skeleton), Pagination, FilterChips
```

### 6.2 Data fetching
- One fetch module per backend API group; components never call `fetch` directly.
- Fetch in async Server Components with `cache: "no-store"`; wrap each section in `<Suspense>` with a skeleton, and key the Suspense on the active filters so a filter change shows the loading state.
- Use `React.cache` for combined calls shared by several components in one request (e.g. `getServiceTitanSummary`).
- Every section handles its own loading / empty / error state, so one failing endpoint never blanks the page (`Promise.allSettled` where one card has several endpoints).

### 6.3 Section ready flags
`src/lib/sections.ts` lists every section with `true` (live) or `false` (shows `<PendingState />`). Turning a placeholder live = wire the fetch + flip one flag. Currently live: `financialOverview`, `dataQuality`, `fieldOperations`, `demandAlerts`, `briefHeader`, `escalations`.

### 6.4 Rule registry (`src/lib/rules.ts`)
Never hardcode rule labels, sections, severities or value formats in components. Each entry has `code`, `label`, `section`, `severity` (`red` / `amber` / `blue`), `metricLabel`, `metricFormat` (`ratio` → %, `money` → $, `number`), and optional `detailFormats` (per-`details`-key format, e.g. money fields). Unknown codes fall back to a generic entry, so a new backend rule never crashes the UI — but add it here to place it on the right page.

| Code | Label | Section → page | Severity | Metric | Baseline | Dimension(s) |
|---|---|---|---|---|---|---|
| D-01 | Booking rate decline | demand → `/demand-alerts` | red | fraction | fraction | CSR name or `TENANT_TOTAL` |
| D-06 | Objection category spike | demand | amber | fraction | fraction | objection category |
| F-03 | Discount leakage | financial → `/financial-alerts` | amber | fraction (discount ÷ gross) | fraction | `QUICKBOOKS_TOTAL` |
| F-04 | AR aging spike | financial | amber | fraction (overdue share) | fraction | `QUICKBOOKS_TOTAL`, `SERVICETITAN_TOTAL` |
| F-04c | AR concentration | financial | amber | fraction (top customer share) | **null** | `QUICKBOOKS_TOTAL` |
| F-04d | Credit memo spike | financial | red | **dollars** (this week) | **dollars** (weekly avg) | `QUICKBOOKS_TOTAL` |
| F-05 | Revenue reconciliation gap | financial | red | fraction (ST vs. QBO gap) | **null** | `TENANT_TOTAL` |

Dimension labels: `TENANT_TOTAL` → "Company total", `QUICKBOOKS_TOTAL` → "QuickBooks (company total)", `SERVICETITAN_TOTAL` → "ServiceTitan (company total)"; anything else renders as-is.

The `details` keys per F rule are documented in the backend rule files (`Backend/src/modules/detect/rules/`). Open question: whether `increasePoints` / `thresholdPoints` are points or fractions — they currently render as raw numbers.

### 6.5 Formatting (`src/lib/format.ts`)
- `formatMoney(decimalString)` — CAD, passes the string straight to `Intl.NumberFormat` (exact, no float parsing). Never `parseFloat` a money string.
- `formatRatio("0.4200")` → `42%` (decimal strings), `formatFraction(0.913)` → `91.3%` (numeric 0–1 values such as classifier confidence), `formatCount`, `formatDecimal`.
- Dates/times are shown in business time, `America/Vancouver` (PT): `formatDate`, `formatDateTime`, `formatReportDate`.
- `formatEnumLabel("PARTIALLY_PAID")` → "Partially Paid", `humanizeKey("dropPoints")` → "Drop Points".

### 6.6 Filters in the URL
Filters live in search params so they're shareable and server-rendered:
- Date range: `<prefix>From` / `<prefix>To` — prefixes `inv` (invoices), `pay` (payments), `alerts` (alert lists + dashboard), `jobs` (ST jobs card, plus `jobsDept` for department). Omitted = month-to-date. Presets and the picker are in `components/filters/DateRangePicker`.
- Rule code: `?ruleCode=`; ST lists: `?status=`, `?classification=`, `?page=`.
- Chip/pagination links are built with `listHref` / `FilterChips` so other active filters are kept and the page resets to 1.

### 6.7 Confidential data and roles
- Technician sales (`/technicians/summary`, and `technicians` inside ST `/summary`) are confidential. `canViewConfidential()` is checked **before** fetching, and everything is server-rendered, so restricted viewers never receive the data.
- The backend has no user roles yet, so `getViewerRole()` returns `"staff"` for everyone and the card is hidden. When roles ship, wire `getViewerRole()` to `/api/auth/me`.
- ⚠️ This frontend gate is not security on its own. The reporting and alerts endpoints currently have **no backend auth** (only `/api/auth/me` and `/api/integrations/*` require a token). Confidential and financial data must be protected on the backend.

---

## 7. Known data caveats (not frontend bugs)

- If a reporting card shows all zeros, check the backend DB first (empty DB, sync not run, identity refresh not run).
- The alerts table may contain test fixtures (period years 2095–2096) or mock narratives (`"should not be called for this row"`) if backend tests were run against a non-test database. Fix and clean up on the backend.
- An F-series page showing "No financial alerts" means no F rows exist for the selected period. Confirm on the backend that Detect has run with the F rules deployed.

---

## 8. Keeping this guide current

When the backend ships a new API, send an **API Drop** in the frontend chat:

```
NEW API READY

Endpoint: GET /api/...
Maps to: <section/page from Section 3 or 5>
Rule code(s) if applicable: F-04, ...
Query params: (date filter? pagination? enums?)
Response shape:
{ "status": "success", "data": { "field": "type/example" } }
Notes: money as decimal strings, nullable fields, fractions vs. dollars, auth required?, etc.

Task: implement it in that section following FRONTEND_BUILD_GUIDE.md conventions
(fetch module, rule registry, section flag, formatters, empty states).
```

After implementing it, **update this file in the same change**: add the endpoint to Section 4, flip the row in Section 3/5, and add any new rule to the 6.4 table. Bump the "Last synced" date at the top.
