# TruFinity Plumbing Heating & Cooling – BI & Dashboard System (Backend)

This is the central knowledge base and single source of truth for the TruFinity backend.
**An AI agent reading this file should be able to fully understand the current architecture and state.**

## Project Overview

The system collects data from the client's existing systems, normalizes it, runs it through a KPI/Rules engine, creates alerts/escalations, feeds Claude AI for a daily executive brief, and serves data to the Frontend Dashboard.

### Eventual Backend Flow
**Client Systems → APIs/OAuth → Data Ingestion → PostgreSQL → Data Normalization → KPI/Rules Engine → Alerts/Escalations → Claude AI → Daily Executive Brief → Backend APIs → Frontend Dashboard**

## Current Scope & Status

The backend foundation and the initial raw-ingestion integrations are established. Downstream business logic remains deferred.

- [x] Node.js + TypeScript foundation — **Done**
- [x] Strict TypeScript configuration — **Done**
- [x] PostgreSQL connection/configuration via Docker Compose — **Done**
- [x] Database migration support (Knex) — **Done**
- [x] Clean modular project structure — **Done**
- [x] Environment variable configuration (Zod validation) — **Done**
- [x] Basic application bootstrap — **Done**
- [x] Health-check endpoint (`GET /health`) — **Done**
- [x] Centralized error handling — **Done**
- [x] Basic request logging (Morgan/Winston) — **Done**
- [x] Linting and formatting (ESLint/Prettier) — **Done**
- [x] Testing foundation (Jest/Supertest) — **Done**
- [x] README and documentation — **Done**
- [x] ServiceTitan raw ingestion for Customers, Locations, Jobs, Appointments, Leads, Bookings, Invoices, Payments, and Technicians — **Done and automated-test verified**
- [x] Shared raw ingestion retries, stale-run recovery, advisory-lock concurrency protection, append-only history, and `is_latest` handling — **Done and automated-test verified**
- [x] QuickBooks durable OAuth/token persistence — **Done and automated-test verified**
- [x] QuickBooks CompanyInfo raw ingestion — **Done and automated-test verified**
- [x] QuickBooks Customer historical pagination implementation — **Done and automated-test verified; live verification blocked by QBO Sandbox HTTP 401**

## Technology Stack

* **Runtime**: Node.js
* **Language**: TypeScript
* **Framework**: Express.js
* **Database**: PostgreSQL (via `pg` driver)
* **Query Builder / Migrations**: Knex.js
* **Environment Validation**: Zod
* **Logging**: Morgan (HTTP) & Winston (App)
* **Testing**: Jest & Supertest
* **Linting and Formatting**: ESLint/Prettier

## Architecture & Directory Structure

```text
trufinity-backend/
├── src/
│   ├── config/          # Environment variables and configuration (Zod schema)
│   ├── database/        # PostgreSQL connection and Knex instance setup
│   ├── modules/         # Integration and business modules
│   ├── middleware/      # Centralized error handling and request logging
│   ├── shared/          # Shared utilities, constants, and types
│   ├── utils/           # Utilities such as Winston logger
│   ├── app.ts           # Express app setup and middleware registration
│   └── server.ts        # Entry point, starts the HTTP server
├── migrations/          # Knex database migrations (TypeScript)
├── tests/               # Unit and integration tests
├── .env.example         # Example environment variables
├── docker-compose.yml   # PostgreSQL local development setup
├── knexfile.ts          # Knex migration configuration
├── tsconfig.json        # Strict TypeScript configuration
└── README.md            # Local setup instructions
```

## Running the Application Locally

1. Install dependencies: `npm install`
2. Set up environment: Copy `.env.example` to `.env`
3. Start database: `docker-compose up -d`
4. Run migrations: `npm run migrate:latest`
5. Start development server: `npm run dev`

## Data Ingestion Architecture

Provider payloads are stored unchanged as JSONB in raw tables. Raw rows are append-only, retain UUID identity and source IDs, reference sync runs, and maintain one `is_latest=true` row per source ID. Sync metadata is advanced only after successful raw persistence. Invalid records are captured in `sync_errors`; failures never log credentials, tokens, app keys, authorization codes, or provider response bodies.

ServiceTitan Export API entities use `from`/`continueFrom` continuation. Technicians use the Standard API with page/pageSize pagination and `modifiedOnOrAfter` based on stored metadata. QBO CompanyInfo is a full refresh. QBO Customers use `SELECT * FROM Customer MAXRESULTS 1000 STARTPOSITION {position}` for historical pagination.

## QuickBooks Online Status and Pending Work

Durable QBO OAuth/token state is stored in PostgreSQL and restored across process restarts. CompanyInfo ingestion is complete and test verified. Customer historical ingestion is implemented and test verified, but controlled live verification is **BLOCKED** because the configured QBO Sandbox access token returned HTTP 401 Unauthorized.

Remaining QBO work:

- Complete live verification of Customers after valid authorization is restored.
- Implement and verify historical Invoices ingestion.
- Implement and verify historical Payments ingestion.
- Implement and verify historical Accounts ingestion.
- Add CDC-based incremental synchronization.

## Future Features / Integrations (Deferred)

The architecture is prepared for the following integrations, which will be built as independent modules within `src/modules/`:

* ServiceTitan Integration — **Raw ingestion implemented for the entities listed above**
* QuickBooks Online Integration — **CompanyInfo implemented; Customer live verification blocked; remaining entities pending**
* Dialpad Integration — **Pending**
* Google Workspace Integration — **Pending**
* Google Ads Integration — **Pending**
* Google Business Profile Integration — **Pending**
* Lace AI Integration (if API export is available) — **Pending**
* Claude AI Daily Brief Generator — **Pending**
* KPI/Rules Engine — **Not started**
* Dashboard REST APIs — **Not started**

Normalization, ST↔QBO identity resolution, canonical/unified transformations, KPI calculations, dashboard logic, and scheduling have not started.

*Note: For every future feature or integration, update this file with its description, architecture, database changes, and dependencies.*

## Current Confirmed Status (31 August 2026)

### ServiceTitan — Done

Raw ingestion is implemented for Customer, Location, Job, Appointment, Lead, Booking, Invoice, Payment, and Technician. Shared reliability features include historical/versioned raw persistence, latest-record handling, sync tracking, retries, stale-run recovery, advisory-lock protection, transaction-safe persistence, and safe logging. Production reliability fixes for advisory-lock cleanup and historical timestamp uniqueness are complete.

Controlled live verification was completed for Appointments, Leads, Bookings, Payments, Technicians, and Invoices. Successful persistence, source-ID integrity, latest/history handling, metadata updates, and zero sync errors were confirmed for completed runs. Invoice recovery completed successfully with 14,111 processed records, 14,111 latest records, 28,222 historical records, 42,333 total raw records, and zero sync errors. Multi-batch continuation was mock-tested but not live-exercised where the tenant returned a single batch. Technician incremental `modifiedOnOrAfter` behavior has not yet been separately live-exercised.

ServiceTitan normalization, identity resolution, KPI logic, dashboards, and scheduled production synchronization are not complete.

### QuickBooks Online — Implemented and Test Verified

Durable OAuth/token persistence, token restoration after process restart, and token refresh persistence are implemented. Raw ingestion is implemented for CompanyInfo, Customers, Invoices, Payments, and Accounts. Applicable entities support historical pagination, resume metadata, append-only history, latest-record handling, retries, stale-run recovery, advisory locks, transactional persistence, metadata tracking, and safe logging. Automated verification is green with 82 tests passed; build passes; relevant lint passes with the existing shared API-client `no-explicit-any` warning; and no database migrations are pending.

QBO Customer live verification is **BLOCKED**. Durable token restoration worked and the Sandbox was reached, but the API returned HTTP 401 Unauthorized. Existing Customer data remains intact and no new live Customer data was inserted during the failed attempt. Valid Sandbox authorization/reauthorization is required. A stable staging/AWS environment is preferred for the OAuth callback and reauthorization.

### QBO CDC — Planned, Not Implemented

CDC is intended for Customers, Invoices, Payments, and Accounts. CompanyInfo remains on the full-refresh path. Deleted-record response shape and timestamp boundary behavior must be confirmed before implementation. The recommended sequence is Customer CDC, then Invoice, Payment, and Account CDC. CDC must use separate watermark state from historical pagination. No live CDC verification has occurred.

### Lace AI — Research Complete, Implementation Blocked

R&D and data-access evaluation are complete. Call Analysis Export through S3/SFTP was selected as the primary automated BI feed. Sample Call Analysis, Agent Performance, and CSR Scorecard exports were reviewed; raw-layer structure, TypeScript types, historical backfill, and incremental delivery requirements were defined. Lace data will eventually require reconciliation with ServiceTitan job/invoice data. Daniel/client has been contacted regarding S3 delivery, preferred bucket/access, and historical export. Lace AI ingestion is blocked on client/Lace S3 delivery and access setup and is not implemented.

### AWS/Staging — Pending External Access

AWS access and setup are being arranged for stable staging/deployment and QBO OAuth reauthorization. Production deployment is not complete, and no unconfirmed AWS infrastructure details are assumed.

### Current Blockers / Dependencies

- Valid QBO Sandbox authorization/reauthorization for controlled Customer verification.
- AWS/staging access and deployment permissions.
- Lace AI S3 delivery/access configuration and historical export.
- Any remaining ServiceTitan API or account approvals, if required by the tenant.

### Overall Project Boundary

The raw ingestion foundation is substantially implemented, but the overall BI project is not complete. Normalization, ST↔QBO identity resolution, canonical/unified transformations, KPI calculations, dashboard logic, and scheduling have not started.
