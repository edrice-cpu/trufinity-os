<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# TruFinity Frontend — Build Guide

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5, strict mode |
| Styling | Tailwind CSS v4 |
| Data fetching | Server Components + `server-only` fetch (no React Query / SWR) |
| Auth | Session cookie → `getSessionToken()` → `Authorization: Bearer` |
| Runtime | Node.js, `server-only` enforced on all API modules |

---

## Project Structure

```
src/
├── app/
│   ├── (auth)/           — Login, forgot/reset password, server actions
│   └── (dashboard)/      — All authenticated pages (layout.tsx guards auth)
│       ├── layout.tsx         — Auth guard + DashboardShell + LaceFreshnessBanner
│       ├── responsiveness/    — Responsiveness page (unanswered emails)
│       ├── integrations/      — QB + ServiceTitan connection cards
│       └── ...other pages
├── components/
│   ├── layout/           — DashboardShell, Sidebar, Topbar, NavProgressBar
│   ├── lace/             — LaceFreshnessBanner (Server Component)
│   ├── sections/
│   │   ├── responsiveness/   — UnansweredSummaryCards, UnansweredEmailsTable
│   │   └── servicetitan/     — ST-specific section components
│   ├── ui/               — Card, Badge, Pagination, States, Icon, etc.
│   └── filters/          — DateRangePicker, DepartmentFilter, useUrlParams
└── lib/
    ├── api/
    │   ├── client.ts          — apiGet / apiGetPage (uses React cache(), server-only)
    │   ├── google.ts          — Work items (list, detail, stats)
    │   ├── lace.ts            — Lace AI sync status
    │   ├── reporting.ts       — QuickBooks reporting
    │   ├── responsiveness.ts  — Unanswered emails (list + summary)
    │   └── servicetitan.ts    — ST jobs, invoices, payments, sync status
    ├── auth/
    │   ├── backend.ts         — backendFetch() with 10s timeout + Bearer auth
    │   └── session.ts         — Cookie management + getCurrentUser()
    ├── sections.ts            — Feature flags (flip to true when API is ready)
    ├── format.ts              — formatMoney, formatDate, formatDateTime, etc.
    └── nav.ts                 — Sidebar navigation items
```

---

## Data Fetching Patterns

### Pattern A — `apiGet` (uses `client.ts`, React `cache()`)
Use for reporting endpoints that don't need a token passed explicitly (token pulled from cookie internally).

```ts
// src/lib/api/lace.ts
import { cache } from "react";
import { apiGet } from "./client";

export const getLaceSyncStatus = cache(() =>
  apiGet<LaceExportFreshness[]>("/api/reporting/lace/sync-status"),
);
```

### Pattern B — `backendFetch` (uses `auth/backend.ts`, explicit token)
Use for endpoints accessed from page Server Components where the token is read from the cookie and passed explicitly.

```ts
// src/lib/api/responsiveness.ts
import { backendFetch } from "@/lib/auth/backend";

export async function listUnansweredEmails(token: string, filters = {}): Promise<UnansweredListFetchResult> {
  const response = await backendFetch<{ data: UnansweredEmailListResult }>(
    `/api/google/reporting/responsiveness/unanswered${buildQuery(filters)}`,
    { token },
  );
  if (response.status === 401) return { kind: "unauthenticated" };
  if (!response.ok || !response.data?.data) return { kind: "error", message: "..." };
  return { kind: "ok", data: response.data.data };
}
```

### Page Server Component pattern
```ts
// src/app/(dashboard)/responsiveness/page.tsx
export default async function Page({ searchParams }: PageProps<"/responsiveness">) {
  const token = await getSessionToken();
  if (!token) redirect("/login");

  const [listResult, summaryResult] = await Promise.all([
    listUnansweredEmails(token, filters),
    getUnansweredSummary(token),
  ]);

  if (listResult.kind === "unauthenticated") redirect("/login");
  // ...render
}
```

---

## Implemented Backend APIs

### Lace AI
| Method | Endpoint | Function | Notes |
|---|---|---|---|
| GET | `/api/reporting/lace/sync-status` | `getLaceSyncStatus()` | Returns `LaceExportFreshness[]`; banner shown when status ≠ OK |

### Google / Work Items
| Method | Endpoint | Function |
|---|---|---|
| GET | `/api/google/work-items` | `listWorkItems(token, filters)` |
| GET | `/api/google/work-items/:id` | `getWorkItem(token, id)` |
| GET | `/api/google/work-items/stats` | `getWorkItemStats(token)` |

### Responsiveness (R01)
| Method | Endpoint | Function | Query Params |
|---|---|---|---|
| GET | `/api/google/reporting/responsiveness/unanswered` | `listUnansweredEmails(token, filters)` | `page`, `page_size`, `status`, `classification`, `mailbox_address` |
| GET | `/api/google/reporting/responsiveness/unanswered/summary` | `getUnansweredSummary(token, mailbox?)` | `mailbox_address` |

### ServiceTitan
| Endpoint | Function |
|---|---|
| `/api/reporting/servicetitan/summary` | `getServiceTitanSummary()` |
| `/api/reporting/servicetitan/jobs/summary` | `getStJobsSummary(filters)` |
| `/api/reporting/servicetitan/sync-status` | `getStSyncStatus()` |
| + invoices, payments, leads, appointments, customers, technicians | see `servicetitan.ts` |

### QuickBooks
| Endpoint | Function |
|---|---|
| `/api/reporting/quickbooks/summary` | `getQuickbooksSummary()` |
| `/api/reporting/quickbooks/invoices/summary` | `getInvoiceSummary(range)` |
| `/api/reporting/quickbooks/payments/summary` | `getPaymentSummary(range)` |

---

## Adding a New API — Checklist

1. **Add types + fetch function** in `src/lib/api/<module>.ts` (follow Pattern A or B above)
2. **Create section component(s)** in `src/components/sections/<module>/`
3. **Update page** in `src/app/(dashboard)/<page>/page.tsx`
4. **Flip `sectionReady` flag** in `src/lib/sections.ts` from `false` → `true`
5. **Run** `npx tsc --noEmit` — must pass with zero errors
6. **Update this guide** — add the new endpoint to the Implemented APIs table

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BACKEND_API_URL` | `http://localhost:3000` | Base URL of the TruFinity backend |

---

## Feature Flags (`src/lib/sections.ts`)

Flip to `true` when the backend API is wired and the page is production-ready:

```ts
export const sectionReady = {
  financialOverview: true,   // ✅ QuickBooks
  dataQuality: true,         // ✅ QBO completeness
  fieldOperations: true,     // ✅ ServiceTitan
  demandAlerts: true,        // ✅
  briefHeader: true,         // ✅
  escalations: true,         // ✅ Work items
  responsiveness: true,      // ✅ Unanswered emails (R01)
  scorecard: false,          // ⏳ pending
  redFlags: false,           // ⏳ pending
  marketing: false,          // ⏳ pending
  watchList: false,          // ⏳ pending
  opportunities: false,      // ⏳ pending
  closedLoop: false,         // ⏳ pending
};
```

