import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../auth/auth.middleware';
import { googleWorkspaceService, type WorkItemWorkType, type WorkItemWorkflowStatus, type WorkItemSlaState } from './google-workspace.service';

const router = Router();

router.use(requireAuth);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WORK_TYPES = ['ESCALATION', 'REVIEW_REQUIRED'] as const;
const WORKFLOW_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED', 'NOT_A_PROBLEM'] as const;
const SLA_STATES = ['UNCONFIGURED', 'ON_TRACK', 'BREACHED', 'MET'] as const;

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

export const googleRouter = router;
