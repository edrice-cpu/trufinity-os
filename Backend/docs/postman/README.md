# Google Workspace reporting API test collection

Import `google-workspace-reporting.postman_collection.json` and then import `google-workspace-local.postman_environment.json`. Select the local environment, set `baseUrl` to the app-only listener (for example `http://127.0.0.1:3000`), and paste a freshly issued client bearer token into the secret `bearerToken` variable. Never save a production token in the collection or environment export.

The collection has 16 requests: 13 distinct routes currently present in `src/modules/google/google.routes.ts`, plus three negative authorization examples. The local source does not define 16 distinct APIs; the three extra distinct routes requested by the project brief are not named anywhere in the repository and are therefore not invented here.

| Method | Route | Contract/filters |
|---|---|---|
| GET | `/api/google/work-items/stats` | `data`: open, escalation, reviewRequired, acknowledged, resolved, breached counts |
| GET | `/api/google/work-items` | `page`, `pageSize`, `mailbox_address`, `work_type`, `workflow_status`, `sla_state`; `data:{items,total,page,pageSize}` |
| GET | `/api/google/work-items/:id` | UUID; metadata-only work item or 404 |
| POST | `/api/google/work-items/:id/acknowledge` | mutation; updated work item or 404 |
| POST | `/api/google/work-items/:id/resolve` | JSON `resolution_note`; 400/404/updated item |
| POST | `/api/google/work-items/:id/not-a-problem` | optional `dismissal_reason`; 400/404/updated item |
| GET | `/api/google/reporting/responsiveness/unanswered/summary` | `mailbox_address`, `status`, `classification`/`is_emergency`, `from_date`, `to_date`; aggregate data |
| GET | `/api/google/reporting/responsiveness/unanswered` | same filters plus `page`, `page_size`; paginated alert metadata |
| GET | `/api/google/reporting/responsiveness/stalled` | `mailbox_address`, `status`, `stall_reason`, `page`, `page_size` |
| GET | `/api/google/reporting/responsiveness/reply-latency` | `mailbox_address`, `status`, `from_date`, `to_date`, `page`, `page_size` |
| GET | `/api/google/reporting/responsiveness/after-hours` | `mailbox_address`, `status`, `page`, `page_size` |
| GET | `/api/google/reporting/responsiveness/aging-queue/summary` | `mailbox_address`; requires completed R05 backfill |
| GET | `/api/google/reporting/responsiveness/aging-queue` | `mailbox_address`, `page`, `page_size`, `sort` |

Every route is behind bearer `requireAuth` and `createRequireClientOnly`; unauthenticated calls should return 401 and authenticated non-client calls 403. Responses are metadata-only. Work-item and classification routes depend on persisted classification/work-item rows; R01 emergency classification depends on trusted classification records; R02–R04 read persisted alert records; R05 reads completed derived thread state/facts and returns controlled 503 `R05_BACKFILL_INCOMPLETE` before completion.

For read-only testing, run the 10 GET requests first, then the three negative examples. Leave the three POST requests unrun unless a separate mutation approval and a real test work-item ID are available. Validate HTTP 200, `status: "success"`, pagination/count consistency, mailbox filters, oldest/newest R05 ordering, and absence of subject/body/snippet/HTML/attachment/payload fields. The collection test script performs the privacy checks automatically.
