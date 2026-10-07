FRONTEND MD FILE:





# TruFinity BI Dashboard — Frontend Build Guide

> **Purpose of this file**: Hand this file directly to Claude on the frontend project. It explains what the product is (per `SPEC-BI-001`), what to build in the UI right now, exactly which backend APIs exist today (with real request/response shapes), and which parts of the UI are placeholders for features the backend has not built yet. As the backend ships more APIs, this file will be updated with new "✅ Ready" sections — re-paste the updated file into the same chat and ask Claude to implement the newly-ready section(s) only.

---

## 1. What this product is

TruFinity is a plumbing/HVAC/cooling company operating across 5 Okanagan/Thompson markets (Kelowna, West Kelowna, Vernon, Penticton, Kamloops). This system replaces the owner manually checking 6 different apps every morning. It is **not a chatbot** — it's a governed data warehouse with:

- **Deterministic rules** that detect problems (financial, operational, customer-escalation, demand, marketing) against owner-editable thresholds.
- **An LLM used only to write prose** around numbers it did not calculate — it never computes, sums, or infers a figure.
- **A daily executive brief** (email + mobile web view) delivered every morning, plus a **drill-down dashboard** for on-demand detail.

The frontend you are building **is the dashboard** (Section 2.1 of the spec: "a live web dashboard for on-demand drill-down into any flagged item") and, eventually, the mobile-readable web view of the daily brief (Section 7).

### Non-negotiable design principle to carry into the UI

Every number shown in the UI comes from a backend API, computed deterministically in the warehouse. **Never let the frontend calculate, sum, average, or derive a financial/operational figure client-side beyond simple display formatting (currency/date formatting, rounding for display).** If a KPI is missing, ask for a new backend endpoint — do not compute it from raw rows in JS. This mirrors the backend's own rule: the LLM (and by extension, the frontend) narrates/displays; it does not calculate.

---

## 2. Architecture context (so you understand why data looks the way it does)

Backend is Node.js/TypeScript + Express + PostgreSQL, structured in 5 layers:

1. **Extract** — pulls raw data from ServiceTitan, QuickBooks Online, Gmail, Lace AI (Dialpad not yet built).
2. **Store** — immutable raw tables + "unified"/"canonical" normalized tables in Postgres.
3. **Detect** — deterministic SQL rules engine, writes rows into a `detected_alerts` table. Rule IDs match the spec exactly (e.g. `D-01`, `F-04a`, `E-05`).
4. **Narrate** — an LLM (Anthropic Claude) turns a `detected_alerts` row into a short human-readable sentence, stored back on that same row (`narrative` field). A validator guarantees every number in that sentence exists in the source data — so the `narrative` text is safe to render as-is.
5. **Deliver** — a read-only API layer that exposes what layers 3/4 produced. This is what your frontend calls.

**Consequence for the frontend**: alerts (rule violations) and reporting KPIs are two different kinds of data, from two different API groups, described below.

---

## 3. What to actually build in the UI, right now

Build a single-page dashboard with the sections below. Sections marked **✅ Ready** have working APIs today — build them fully. Sections marked **🚧 Placeholder** must be built as visually-present-but-empty/disabled sections (see Section 6 for exactly how) so that no restructuring is needed when the backend ships them — you'll just wire in data.

### 3.1 Financial Overview — ✅ Ready

KPI cards at the top of the dashboard:
- Total active invoices, outstanding AR, invoice total, tax, discount
- Paid / partially-paid / unpaid / zero-value invoice counts (as a breakdown chart or stat row)
- Payment totals, applied vs. unapplied amounts, reconciliation status (reconciled vs. unreconciled payment counts)

**API**: `GET /api/reporting/quickbooks/invoices/summary`, `GET /api/reporting/quickbooks/payments/summary` (or the combined `summary` endpoint — see Section 4).

### 3.2 Data Quality / Sync Health panel — ✅ Ready

This is *not* in the spec's brief directly, but the spec (Section 1.1) explicitly cares about audit-grade data integrity because the business is being prepped for sale. Build this as an admin/ops panel (can be a separate tab, not the main scorecard):
- Per-entity (Customer/Invoice/Payment) sync completeness: raw records vs. mapped/unified records, broken links, duplicate identities, mapping errors.
- ServiceTitan↔QuickBooks customer identity match quality: verified/unresolved/merged counts.
- Payment-to-invoice application integrity: orphaned references, duplicate pairs, stale identities.

**API**: `GET /api/reporting/quickbooks/completeness`, `GET /api/reporting/quickbooks/customer-identity-quality`, `GET /api/reporting/quickbooks/payment-application-integrity`.

### 3.3 Demand & Booking Alerts widget — ✅ Ready (narrow)

A small card/list titled something like "Demand Alerts" showing any currently-detected D-series exceptions:
- **D-01**: booking rate decline (tenant-wide or per-CSR)
- **D-06**: objection-category spike

Each alert row should show: rule code, dimension (e.g. CSR name or "TENANT_TOTAL"), metric value vs. baseline, the `narrative` text if present (this is the pre-validated LLM sentence — render it as trusted plain text), and detected-at timestamp. Support filtering by rule code and clicking through to a detail view (single alert).

**API**: `GET /api/brief/alerts` (list, optional `?ruleCode=D-01`), `GET /api/brief/alerts/:id` (detail).

### 3.4 Daily Executive Brief page — 🚧 Placeholder (structure now, fill later)

Per spec Section 7, the eventual daily brief has this exact fixed section order (build the page shell with these sections now, each showing an empty/"coming soon" state until wired):

1. **Header** — date, data-freshness timestamp per source, extraction failures.
2. **Scorecard** — yesterday/week-to-date/month-to-date on a fixed metric set with prior-period comparison. *(Partially fillable today from 3.1 — build the shell for the full time-series scorecard, but only the current-snapshot numbers are real right now.)*
3. **Customer Escalations** — E-series flags (problem emails, calls, reviews, silent-signal cases). Placed **above** financial red flags — this is the section the owner is "buying." Each item: customer name, source, reason, link to original.
4. **Red Flags** — all other RED severity exceptions (F/O series), ranked by dollar impact.
5. **Responsiveness** — unanswered inbound messages/aging threads by mailbox/person, counts and ages only, never message content.
6. **Marketing** — cost per booked job, gross profit per ad dollar by campaign, attribution integrity gate.
7. **Watch list** — AMBER exceptions, capped at 10 items.
8. **Opportunities** — BLUE exceptions with estimated revenue value, capped at 5 items.
9. **Closed loop** — resolved-vs-still-open items with age counter, named owner, SLA status.

**Build these as named, styled, collapsible sections with a muted "No data yet — pending backend integration" empty state.** Do not fabricate sample numbers in these sections — an empty state is honest; a fake number is not (this matches the spec's own zero-tolerance stance on invented figures).

### 3.5 Alert detail / drill-down — ✅ Ready (for D-series only today)

Clicking any alert (from 3.3, and later 3.4) should open a detail view showing the full alert record: rule code, dimension, period start/end, baseline period, metric value, baseline value, `details` (JSON — render as a formatted key/value list, not raw JSON dump), narrative, narrated-at, detected-at.

**API**: `GET /api/brief/alerts/:id`.

---

## 4. Exact API reference (what exists today)

Base URL: whatever the backend deploys to (ask the user for the current dev/staging URL — likely `http://localhost:<port>` in dev). All responses are JSON.

### 4.1 `GET /api/reporting/quickbooks/summary`

Returns everything in 4.2–4.6 in a single call. **Use this for the dashboard's initial page load**; use the individual endpoints below for widget-level refresh/drill-down.

```json
{
  "status": "success",
  "data": {
    "invoices": { /* shape in 4.2 */ },
    "payments": { /* shape in 4.3 */ },
    "qboCompleteness": { /* shape in 4.4 */ },
    "customerIdentityQuality": { /* shape in 4.5 */ },
    "paymentApplicationIntegrity": { /* shape in 4.6 */ }
  }
}
```

### 4.2 `GET /api/reporting/quickbooks/invoices/summary`

```json
{
  "status": "success",
  "data": {
    "totalActiveInvoices": 0,
    "paidCount": 0,
    "partiallyPaidCount": 0,
    "unpaidCount": 0,
    "zeroValueCount": 0,
    "unsupportedCount": 0,
    "invoiceTotal": "0.00",
    "outstandingAr": "0.00",
    "totalTax": "0.00",
    "totalDiscount": "0.00",
    "brokenTargetCount": 0
  }
}
```
All money fields are **decimal strings** (e.g. `"12345.67"`) — never parse them as JS floats for calculation; only format them for display (e.g. with `Intl.NumberFormat` after a safe decimal-aware parse, or a decimal library). Counts are integers.

### 4.3 `GET /api/reporting/quickbooks/payments/summary`

```json
{
  "status": "success",
  "data": {
    "paymentCount": 0,
    "paymentTotal": "0.00",
    "unappliedTotal": "0.00",
    "mappedApplicationTotal": "0.00",
    "reconciledPaymentCount": 0,
    "unreconciledPaymentCount": 0,
    "netReconciliationDifference": "0.00",
    "paymentsWithoutInvoiceApplications": 0
  }
}
```

### 4.4 `GET /api/reporting/quickbooks/completeness`

```json
{
  "status": "success",
  "data": {
    "Customer": {
      "latestNonDeletedRawCount": 0,
      "activeIdentityCount": 0,
      "unifiedTargetCount": 0,
      "brokenTargetCount": 0,
      "duplicateSourceIdentityCount": 0,
      "mappingErrorCount": 0
    },
    "Invoice": { /* same shape */ },
    "Payment": { /* same shape */ }
  }
}
```

### 4.5 `GET /api/reporting/quickbooks/customer-identity-quality`

```json
{
  "status": "success",
  "data": {
    "serviceTitanCustomerIdentityCount": 0,
    "verifiedTierACount": 0,
    "unresolvedCount": 0,
    "mergedCount": 0,
    "brokenUnifiedTargetCount": 0,
    "tierAWithoutSharedQboTarget": 0,
    "unresolvedSharingQboTarget": 0
  }
}
```

### 4.6 `GET /api/reporting/quickbooks/payment-application-integrity`

```json
{
  "status": "success",
  "data": {
    "totalApplicationRows": 0,
    "orphanPaymentReferences": 0,
    "orphanInvoiceReferences": 0,
    "duplicatePaymentInvoicePairs": 0,
    "applicationsWithInactiveOrDeletedQboIdentity": 0
  }
}
```

### 4.7 `GET /api/brief/alerts` (optional query: `?ruleCode=D-01`)

Returns the same `{ status, data }` envelope as the reporting endpoints above, with `data` an array, newest first:

```json
{
  "status": "success",
  "data": [
    {
      "id": "uuid",
      "rule_code": "D-01",
      "dimension": "TENANT_TOTAL",
      "period_start": "2026-09-01T00:00:00.000Z",
      "period_end": "2026-09-08T00:00:00.000Z",
      "baseline_start": "2026-08-01T00:00:00.000Z",
      "baseline_end": "2026-08-08T00:00:00.000Z",
      "metric_value": "0.42",
      "baseline_value": "0.55",
      "details": { "...": "rule-specific JSON, render as key/value list" },
      "narrative": "Booking rate fell to 42% this week, down from 55%...",
      "narrated_at": "2026-09-08T06:00:00.000Z",
      "detected_at": "2026-09-08T05:58:00.000Z"
    }
  ]
}
```
`metric_value` / `baseline_value` are **fractions** (`"0.42"` = 42%), for both D-01 and D-06 — multiply by 100 to display.
`narrative` can be `null` if the Narrate step hasn't run yet or failed validation — in that case, render the raw `rule_code` + `metric_value`/`baseline_value` as a fallback (never block the UI on missing narrative text).

### 4.8 `GET /api/brief/alerts/:id`

`{ "status": "success", "data": { ...one alert, same shape as an array element above } }`, or `404 { "status": "error", "message": "Alert not found" }` (also returned for a malformed, non-UUID id).

### Diagnostic-only endpoints — do NOT build UI against these

`/api/integrations/quickbooks/*` (customers, invoices, payments, accounts, companyinfo) are **dev-only diagnostic routes** that call the live QuickBooks API directly with no auth beyond `NODE_ENV=development` gating. They exist for backend debugging, not for the dashboard. If real invoice/customer *list* views are needed later, ask the backend for proper paginated reporting endpoints against the warehouse instead.

---

## 5. What is planned but NOT built yet (do not call these — they don't exist)

Track these as backend work still to come, per the spec. When any of these ships, this file will be updated with a real API contract like Section 4 above.

| Spec area | Rule series | Status |
|---|---|---|
| Customer escalation detection (emails/calls) | E-01 to E-07 | Not built — no Gmail content classification, no Dialpad integration at all |
| Team responsiveness (mailbox metadata) | R-01 to R-05 | Not built — Gmail raw ingestion exists, but no metrics computed on top |
| Financial red flags beyond invoice paid/unpaid | F-01 to F-07 (gross profit gates, margin drift, AR aging brackets, negative-margin jobs) | Not built — only basic invoice PAID/UNPAID/PARTIAL classification exists |
| Operational exceptions | O-01 to O-07 (unsold estimates, callback spikes, capacity imbalance, membership lapses) | Not built |
| Marketing performance | M-01 to M-07 (cost per booked job, attribution integrity) | Not built — no Google Ads integration |
| Opportunity detection | P-01 to P-05 | Not built |
| Daily brief email delivery (06:30 PT) | Section 7 | Not built — `/api/brief/*` only exposes a read-only alert query API today, no actual brief composition/email |
| Threshold configuration UI (owner-editable rule thresholds) | Section 5 intro | Not built — thresholds are currently hardcoded backend env vars, not a config table. **When this ships, it will need its own admin settings screen** — plan a spot for it in the nav now. |
| Action routing / SLA accountability (who owns each alert, ack/resolve clocks) | Section 8 | Not built |
| Dialpad call data | — | Not built |
| Lace AI booking-rate data feeding into D-01/D-06 | — | ✅ Built on the backend (Lace S3 ingestion is live) — this is why D-01/D-06 alerts in 3.3 already work |

---

## 6. How to structure the frontend so it grows cleanly

Because APIs will arrive incrementally, structure the app so adding a new section never requires restructuring:

1. **One data-fetching module per backend API group** (e.g. `api/reporting.ts`, `api/alerts.ts`). When a new endpoint ships, add one function here — don't scatter `fetch` calls in components.
2. **One component per spec section** (Financial Overview, Data Quality, Demand Alerts, Escalations, Red Flags, Responsiveness, Marketing, Watch List, Opportunities, Closed Loop), each independently mountable, each handling its own loading/empty/error state.
3. **A per-section "ready" flag**, not a build-time constant — e.g. a small config object listing which sections have live data — so turning a placeholder into a live section is a one-line change plus wiring the fetch, not a rewrite.
4. **Never hardcode rule-code-to-severity or rule-code-to-label mappings deep in components** — keep a single lookup table (rule code → display name, section, severity color) at the top level, since new rule codes will keep arriving (currently only `D-01`, `D-06` exist; expect `F-*`, `E-*`, `O-*`, `R-*`, `M-*`, `P-*` later, all following the same `detected_alerts` shape from Section 4.7).
5. **Money values**: centralize decimal-string formatting in one utility function, used everywhere — never inline `parseFloat` on a money string.
6. **Empty states over fake data**: every placeholder section (Section 3.4) should look intentionally "not yet connected," not broken and not populated with invented numbers.

## 7. How to ship new APIs WITHOUT re-editing this file

This file is a **one-time framework doc** — paste it into the frontend Claude chat once. It already contains a placeholder (Section 3.4) and a "not built yet" entry (Section 5 table) for every section the spec defines, so the page structure never needs to change again. From now on, when the backend ships a new API, do **not** come back and edit this file. Instead, paste a short **API Drop** message directly into the same frontend chat, filled out like this:

```
NEW API READY

Endpoint: GET /api/reporting/quickbooks/whatever
Maps to spec section: Red Flags (F-04 AR aging)   <-- one of the sections/rows already listed in Section 3/5 of the build guide
Rule code(s) if applicable: F-04, F-04a
Response shape:
{
  "status": "success",
  "data": {
    "field": "type/example"
  }
}
Notes: any quirks (money as decimal string, nullable fields, pagination params, etc.)

Task: implement this in the [section name] section that's currently a placeholder. Follow the conventions in FRONTEND_BUILD_GUIDE.md (money formatting, rule-code lookup table, empty states) already in this chat.
```

Because the frontend chat already has the full guide in its context, Claude just needs: the endpoint, the shape, and which already-existing placeholder section it fills. It flips that one section from placeholder to live, wires the fetch module (Section 6, rule #1), and leaves everything else untouched.

**Only re-paste the whole guide if**: you start a brand-new chat (no prior context), or a delivered API doesn't fit any section already listed here (genuinely new capability outside the spec) — in that case, ask to extend the guide once, not per-API.
