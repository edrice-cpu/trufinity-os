import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, createRequireClientOnly, type AuthenticatedRequest } from '../auth/auth.middleware';
import { googleWorkspaceService, type WorkItemWorkType, type WorkItemWorkflowStatus, type WorkItemSlaState } from './google-workspace.service';
import { listUnansweredAlerts, unansweredAlertSummary, type UnansweredAlertClassification, type UnansweredAlertStatus } from './responsiveness-rule-r01';
import { listStalledAlerts, type StalledAlertStatus, type StallReason } from './responsiveness-rule-r02';
import { listReplyLatencyRecords, type ReplyLatencyStatus } from './responsiveness-rule-r03';
import { listAfterHoursAlerts, type AfterHoursAlertStatus } from './responsiveness-rule-r04';
import { listAgingQueue, agingQueueSummary, type R05Config } from './responsiveness-rule-r05';
import { db } from '../../database';
import { env } from '../../config/env';

const router = Router();

router.use(requireAuth);
router.use(createRequireClientOnly(env.GOOGLE_DASHBOARD_ALLOWED_EMAILS));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORK_TYPES = ['ESCALATION', 'REVIEW_REQUIRED'] as const;
const WORKFLOW_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED', 'NOT_A_PROBLEM'] as const;
const SLA_STATES = ['UNCONFIGURED', 'ON_TRACK', 'BREACHED', 'MET'] as const;

const UNANSWERED_STATUSES = ['OPEN', 'REPLIED'] as const;
const UNANSWERED_CLASSIFICATIONS = ['EMERGENCY', 'GENERAL'] as const;

const parseUnansweredFilters = (req: Request) => {
  const mailboxRaw = req.query.mailbox_address;
  const statusRaw = req.query.status;
  const classificationRaw = req.query.classification;
  const isEmergencyRaw = req.query.is_emergency;
  const fromDateRaw = req.query.from_date;
  const toDateRaw = req.query.to_date;

  const status = typeof statusRaw === 'string' && (UNANSWERED_STATUSES as readonly string[]).includes(statusRaw)
    ? statusRaw as UnansweredAlertStatus : undefined;
  const classification = typeof classificationRaw === 'string' && (UNANSWERED_CLASSIFICATIONS as readonly string[]).includes(classificationRaw)
    ? classificationRaw as UnansweredAlertClassification
    : typeof isEmergencyRaw === 'string' && ['true', 'false'].includes(isEmergencyRaw.toLowerCase())
      ? (isEmergencyRaw.toLowerCase() === 'true' ? 'EMERGENCY' : 'GENERAL') as UnansweredAlertClassification
      : undefined;
  const fromDate = typeof fromDateRaw === 'string' && fromDateRaw.length > 0 ? new Date(fromDateRaw) : undefined;
  const toDate = typeof toDateRaw === 'string' && toDateRaw.length > 0 ? new Date(toDateRaw) : undefined;

  return {
    ...(typeof mailboxRaw === 'string' && mailboxRaw.length > 0 ? { mailboxAddress: mailboxRaw } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(classification !== undefined ? { classification } : {}),
    ...(fromDate !== undefined ? { fromDate } : {}),
    ...(toDate !== undefined ? { toDate } : {}),
  };
};

const invalidDateMessage = (filters: { fromDate?: Date; toDate?: Date }) =>
  (filters.fromDate && isNaN(filters.fromDate.getTime())) ? 'Invalid from_date format.'
    : (filters.toDate && isNaN(filters.toDate.getTime())) ? 'Invalid to_date format.' : null;

router.get('/work-items/stats', async (_req, res, next) => {
  try {
    const stats = await googleWorkspaceService.getWorkItemStats();
    res.json({ status: 'success', data: stats });
  } catch (err) {
    next(err);
  }
});

router.get('/work-items', async (req, res, next) => {
  try {
    const pageRaw = Number(req.query.page ?? 1);
    const pageSizeRaw = Number(req.query.pageSize ?? 25);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(100, Math.floor(pageSizeRaw)) : 25;

    // Public API uses snake_case query parameters; service uses camelCase internally.
    const workTypeRaw = req.query.work_type;
    const workType = typeof workTypeRaw === 'string' && (WORK_TYPES as readonly string[]).includes(workTypeRaw)
      ? (workTypeRaw as WorkItemWorkType) : undefined;

    const workflowStatusRaw = req.query.workflow_status;
    const workflowStatus = typeof workflowStatusRaw === 'string' && (WORKFLOW_STATUSES as readonly string[]).includes(workflowStatusRaw)
      ? (workflowStatusRaw as WorkItemWorkflowStatus) : undefined;

    const mailboxAddressRaw = req.query.mailbox_address;
    const mailboxAddress = typeof mailboxAddressRaw === 'string' ? mailboxAddressRaw : undefined;

    const slaStateRaw = req.query.sla_state;
    const slaState = typeof slaStateRaw === 'string' && (SLA_STATES as readonly string[]).includes(slaStateRaw)
      ? (slaStateRaw as WorkItemSlaState) : undefined;

    const result = await googleWorkspaceService.listWorkItems({
      ...(workType !== undefined ? { workType } : {}),
      ...(workflowStatus !== undefined ? { workflowStatus } : {}),
      ...(mailboxAddress !== undefined ? { mailboxAddress } : {}),
      ...(slaState !== undefined ? { slaState } : {}),
      page,
      pageSize,
    });
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/work-items/:id', async (req, res, next) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) {
      res.status(404).json({ status: 'error', message: 'Work item not found.' });
      return;
    }
    const item = await googleWorkspaceService.getWorkItemById(req.params.id);
    if (!item) {
      res.status(404).json({ status: 'error', message: 'Work item not found.' });
      return;
    }
    res.json({ status: 'success', data: item });
  } catch (err) {
    next(err);
  }
});

router.post('/work-items/:id/acknowledge', async (req, res, next) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) {
      res.status(404).json({ status: 'error', message: 'Work item not found.' });
      return;
    }
    const item = await googleWorkspaceService.acknowledgeWorkItem(req.params.id);
    if (!item) {
      res.status(404).json({ status: 'error', message: 'Work item not found.' });
      return;
    }
    res.json({ status: 'success', data: item });
  } catch (err) {
    next(err);
  }
});

const resolveBodySchema = z.object({
  resolution_note: z.string().min(1, 'resolution_note is required').max(2000),
});

router.post('/work-items/:id/resolve', async (req, res, next) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) {
      res.status(404).json({ status: 'error', message: 'Work item not found.' });
      return;
    }
    const parsed = resolveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        status: 'error',
        message: 'Validation failed.',
        errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const item = await googleWorkspaceService.resolveWorkItem(req.params.id, parsed.data.resolution_note);
    if (!item) {
      res.status(404).json({ status: 'error', message: 'Work item not found.' });
      return;
    }
    res.json({ status: 'success', data: item });
  } catch (err) {
    next(err);
  }
});

const dismissBodySchema = z.object({
  dismissal_reason: z.string().max(500).optional(),
});

router.post('/work-items/:id/not-a-problem', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!UUID_PATTERN.test(id)) {
      res.status(404).json({ status: 'error', message: 'Work item not found.' });
      return;
    }
    const parsed = dismissBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        status: 'error',
        message: 'Validation failed.',
        errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
      return;
    }
    // Actor identity comes exclusively from the authenticated session — never from the request body.
    const actorUserId = (req as AuthenticatedRequest).auth!.user.id;
    const reason = parsed.data.dismissal_reason?.trim() || null;
    const item = await googleWorkspaceService.dismissWorkItem(id, actorUserId, reason);
    if (!item) {
      // null means not found OR terminal status (RESOLVED/CLOSED) that must not be overwritten
      res.status(404).json({ status: 'error', message: 'Work item not found or cannot be dismissed.' });
      return;
    }
    res.json({ status: 'success', data: item });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// R-01 Unanswered Inbound Dashboard
// ---------------------------------------------------------------------------

router.get('/reporting/responsiveness/unanswered/summary', async (req, res, next) => {
  try {
    const filters = parseUnansweredFilters(req);
    const dateError = invalidDateMessage(filters);
    if (dateError) {
      res.status(400).json({ status: 'error', message: dateError });
      return;
    }
    const result = await unansweredAlertSummary(db, filters);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/reporting/responsiveness/unanswered', async (req, res, next) => {
  try {
    const pageRaw = Number(req.query.page ?? 1);
    const pageSizeRaw = Number(req.query.page_size ?? 25);
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? Math.min(100, Math.floor(pageSizeRaw)) : 25;
    const filters = parseUnansweredFilters(req);
    const dateError = invalidDateMessage(filters);
    if (dateError) {
      res.status(400).json({ status: 'error', message: dateError });
      return;
    }
    const result = await listUnansweredAlerts(db, { ...filters, page, pageSize });
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// R-02 Stalled Thread Dashboard
// GET /api/google/reporting/responsiveness/stalled
//
// Read-only. Returns metadata only — no email body, subject, snippet, or
// attachment content. Respects router-level requireAuth guard.
// ---------------------------------------------------------------------------

const STALLED_STATUSES = ['OPEN', 'RESOLVED'] as const;
const STALL_REASONS = ['INACTIVITY', 'EXCESSIVE_EXCHANGES'] as const;

router.get('/reporting/responsiveness/stalled', async (req, res, next) => {
  try {
    const pageRaw = Number(req.query.page ?? 1);
    const pageSizeRaw = Number(req.query.page_size ?? 25);
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? Math.min(100, Math.floor(pageSizeRaw)) : 25;

    const mailboxAddressRaw = req.query.mailbox_address;
    const mailboxAddress = typeof mailboxAddressRaw === 'string' && mailboxAddressRaw.length > 0
      ? mailboxAddressRaw : undefined;

    const statusRaw = req.query.status;
    const status = typeof statusRaw === 'string' && (STALLED_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as StalledAlertStatus) : undefined;

    const reasonRaw = req.query.stall_reason;
    const stallReason = typeof reasonRaw === 'string' && (STALL_REASONS as readonly string[]).includes(reasonRaw)
      ? (reasonRaw as StallReason) : undefined;

    const result = await listStalledAlerts(db, {
      ...(mailboxAddress !== undefined ? { mailboxAddress } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(stallReason !== undefined ? { stallReason } : {}),
      page,
      pageSize,
    });
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// R-03 Reply Latency Dashboard
// GET /api/google/reporting/responsiveness/reply-latency
//
// Read-only. Returns metadata only — no email body, subject, snippet, or
// attachment content. Respects router-level requireAuth guard.
// ---------------------------------------------------------------------------

const LATENCY_STATUSES = ['ON_TIME', 'LATE'] as const;

router.get('/reporting/responsiveness/reply-latency', async (req, res, next) => {
  try {
    const pageRaw = Number(req.query.page ?? 1);
    const pageSizeRaw = Number(req.query.page_size ?? 25);
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? Math.min(100, Math.floor(pageSizeRaw)) : 25;

    const mailboxAddressRaw = req.query.mailbox_address;
    const mailboxAddress = typeof mailboxAddressRaw === 'string' && mailboxAddressRaw.length > 0
      ? mailboxAddressRaw : undefined;

    const statusRaw = req.query.status;
    const status = typeof statusRaw === 'string' && (LATENCY_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as ReplyLatencyStatus) : undefined;

    const fromDateRaw = req.query.from_date;
    const fromDate = typeof fromDateRaw === 'string' && fromDateRaw.length > 0
      ? new Date(fromDateRaw) : undefined;

    const toDateRaw = req.query.to_date;
    const toDate = typeof toDateRaw === 'string' && toDateRaw.length > 0
      ? new Date(toDateRaw) : undefined;

    // Reject invalid date strings before hitting the DB.
    if (fromDate !== undefined && isNaN(fromDate.getTime())) {
      res.status(400).json({ status: 'error', message: 'Invalid from_date format.' });
      return;
    }
    if (toDate !== undefined && isNaN(toDate.getTime())) {
      res.status(400).json({ status: 'error', message: 'Invalid to_date format.' });
      return;
    }

    const result = await listReplyLatencyRecords(db, {
      ...(mailboxAddress !== undefined ? { mailboxAddress } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(fromDate !== undefined ? { fromDate } : {}),
      ...(toDate !== undefined ? { toDate } : {}),
      page,
      pageSize,
    });
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// R-04 After-Hours Backlog Dashboard
// GET /api/google/reporting/responsiveness/after-hours
//
// Read-only. Returns metadata only — no email body, subject, snippet, or
// attachment content. Respects router-level requireAuth guard.
// ---------------------------------------------------------------------------

const AFTER_HOURS_STATUSES = ['OPEN', 'RESOLVED'] as const;

router.get('/reporting/responsiveness/after-hours', async (req, res, next) => {
  try {
    const pageRaw = Number(req.query.page ?? 1);
    const pageSizeRaw = Number(req.query.page_size ?? 25);
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? Math.min(100, Math.floor(pageSizeRaw)) : 25;

    const mailboxAddressRaw = req.query.mailbox_address;
    const mailboxAddress = typeof mailboxAddressRaw === 'string' && mailboxAddressRaw.length > 0
      ? mailboxAddressRaw : undefined;

    const statusRaw = req.query.status;
    const status = typeof statusRaw === 'string' && (AFTER_HOURS_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as AfterHoursAlertStatus) : undefined;

    const result = await listAfterHoursAlerts(db, {
      ...(mailboxAddress !== undefined ? { mailboxAddress } : {}),
      ...(status !== undefined ? { status } : {}),
      page,
      pageSize,
    });
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// R-05 Aging Queue
// GET /api/google/reporting/responsiveness/aging-queue/summary
// GET /api/google/reporting/responsiveness/aging-queue
//
// Read-only. Returns metadata only — no email body, subject, snippet, or
// attachment content. Respects router-level requireAuth guard.
//
// Historical coverage limitation: only threads with messages within the last
// GOOGLE_R01_LOOKBACK_DAYS days are included. Older unanswered threads will
// not appear.
// ---------------------------------------------------------------------------

const buildR05Config = (): R05Config => ({
  businessCalendar: {
    timezone: env.GOOGLE_R01_TIMEZONE,
    startHour: env.GOOGLE_R01_BUSINESS_START_HOUR,
    endHour: env.GOOGLE_R01_BUSINESS_END_HOUR,
    endMinute: env.GOOGLE_R01_BUSINESS_END_MINUTE,
  },
  workspaceDomain: 'trufinity.ca',
  lookbackDays: env.GOOGLE_R01_LOOKBACK_DAYS,
  r01ThresholdMinutes: env.GOOGLE_R01_THRESHOLD_MINUTES,
  useThreadState: true,
});

router.get('/reporting/responsiveness/aging-queue/summary', async (req, res, next) => {
  try {
    const mailboxAddressRaw = req.query.mailbox_address;
    const mailboxAddress = typeof mailboxAddressRaw === 'string' && mailboxAddressRaw.length > 0
      ? mailboxAddressRaw : undefined;

    const result = await agingQueueSummary(db, {
      ...(mailboxAddress !== undefined ? { mailboxAddress } : {}),
    }, buildR05Config());
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

const AGING_SORT_OPTIONS = ['oldest_first', 'newest_first'] as const;

router.get('/reporting/responsiveness/aging-queue', async (req, res, next) => {
  try {
    const pageRaw = Number(req.query.page ?? 1);
    const pageSizeRaw = Number(req.query.page_size ?? 25);
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? Math.min(100, Math.floor(pageSizeRaw)) : 25;

    const mailboxAddressRaw = req.query.mailbox_address;
    const mailboxAddress = typeof mailboxAddressRaw === 'string' && mailboxAddressRaw.length > 0
      ? mailboxAddressRaw : undefined;

    const sortRaw = req.query.sort;
    const sortBy = typeof sortRaw === 'string' && (AGING_SORT_OPTIONS as readonly string[]).includes(sortRaw)
      ? (sortRaw as 'oldest_first' | 'newest_first') : 'oldest_first';

    const result = await listAgingQueue(db, {
      ...(mailboxAddress !== undefined ? { mailboxAddress } : {}),
      sortBy,
      page,
      pageSize,
    }, buildR05Config());
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
});

export const googleRouter = router;
