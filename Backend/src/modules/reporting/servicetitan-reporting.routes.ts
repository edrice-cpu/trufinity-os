import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import { Readable } from 'stream';
import { rateLimit } from 'express-rate-limit';
import { serviceTitanReportingService as service } from './servicetitan-reporting.service';
import { parseDateRangeFilter, parseDepartmentFilter } from '../../utils/dashboard-filters';
import type { StInvoiceListItem, VoicemailCallbackAlertStatus } from './servicetitan-reporting.types';
import { VOICEMAIL_CALLBACK_ALERT_STATUSES } from './servicetitan-reporting.types';
import { createRequireAuth, type AuthenticatedRequest } from '../auth/auth.middleware';
import { authService as defaultAuthService, type AuthService } from '../auth/auth.service';
import {
  TelecomCallsRecordingService,
  RecordingUpstreamError,
  ST_RECORDING_TIMEOUT_MS,
  telecomCallsRecordingService,
} from '../servicetitan/services/telecom-calls-recording.service';
import {
  TelecomCallDetailsService,
  CallDetailsUpstreamError,
  telecomCallDetailsService,
} from '../servicetitan/services/telecom-call-details.service';
import { logger } from '../../utils/logger';

const INVOICE_CLASSIFICATIONS = ['PAID', 'PARTIALLY_PAID', 'UNPAID', 'ZERO_VALUE'] as const;

const pagination = (req: Request) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? ''), 10) || 25));
  return { page, pageSize };
};

const simple = (handler: () => Promise<unknown>): RequestHandler => async (_req, res, next) => {
  try {
    res.json({ status: 'success', data: await handler() });
  } catch (err) {
    next(err);
  }
};

// Numeric-only call ID, 1–20 digits. Prevents path traversal and oversized inputs.
const CALL_ID_RE = /^[0-9]{1,20}$/;

// 30 recording requests per minute per session (or IP for unauthenticated attempts that
// slip past requireAuth). The keyGenerator runs after requireAuth has set req.auth.
const recordingRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // requireAuth always runs before this middleware, so auth.sessionId is guaranteed present.
  keyGenerator: (req) => (req as AuthenticatedRequest).auth!.sessionId,
  message: { status: 'error', message: 'Too many recording requests. Please try again shortly.' },
});

// 60 call-details requests per minute per session.
const callDetailsRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthenticatedRequest).auth!.sessionId,
  message: { status: 'error', message: 'Too many requests. Please try again shortly.' },
});

// Every ServiceTitan reporting route needs a signed-in session: AR, revenue
// and technician sales are confidential (SPEC-BI-001 Section 11). 401
// { status: 'error', message } otherwise, from createRequireAuth.
export const createServiceTitanReportingRouter = (
  recordingService: TelecomCallsRecordingService = telecomCallsRecordingService,
  authService: AuthService = defaultAuthService,
  callDetailsService: TelecomCallDetailsService = telecomCallDetailsService,
): Router => {
  const router = Router();
  const requireAuth = createRequireAuth(authService);

  // Global auth guard — applies to all routes in this router.
  router.use(requireAuth);

  // ─── Reporting routes ─────────────────────────────────────────────────────────
  router.get('/summary', simple(() => service.getSnapshot()));
  // Date (default month-to-date) and Department (default "Company") filters -
  // e.g. ?from=2026-09-01&to=2026-09-30&department=Service.
  router.get('/jobs/summary', async (req, res, next) => {
    try {
      const data = await service.getJobsSummary(parseDateRangeFilter(req), parseDepartmentFilter(req));
      res.json({ status: 'success', data });
    } catch (err) {
      next(err);
    }
  });
  router.get('/invoices/summary', simple(() => service.getInvoicesSummary()));
  router.get('/invoices/ar-aging', simple(() => service.getArAging()));
  router.get('/payments/summary', simple(() => service.getPaymentsSummary()));
  router.get('/leads-bookings/summary', simple(() => service.getLeadsBookingsSummary()));
  router.get('/appointments/summary', simple(() => service.getAppointmentsSummary()));
  router.get('/customers/summary', simple(() => service.getCustomersSummary()));
  router.get('/technicians/summary', simple(() => service.getTechnicianSummary()));
  router.get('/sync-status', simple(() => service.getSyncStatus()));

  // ─── D-02a Voicemail Callback Alerts ─────────────────────────────────────────
  //
  // GET /telecom/alerts/voicemail-callbacks
  //
  // Returns paginated voicemail callback alerts populated by the D-02a rule.
  // Registered BEFORE /telecom/calls/:callId so the static path is matched first.
  //
  // Query parameters:
  //   status    — OPEN | RESOLVED | UNVERIFIABLE (optional)
  //   from, to  — ISO date/datetime (UTC) filter on voicemail_at (optional)
  //   page      — 1-based page number (default: 1)
  //   pageSize  — 1–100 (default: 25)
  //
  // No PII is returned: sourceId is the ST call ID (numeric), not a phone number.

  router.get(
    '/telecom/alerts/voicemail-callbacks',
    callDetailsRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const rawStatus = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
      if (rawStatus && !(VOICEMAIL_CALLBACK_ALERT_STATUSES as readonly string[]).includes(rawStatus)) {
        res.status(400).json({
          status: 'error',
          message: `status must be one of ${VOICEMAIL_CALLBACK_ALERT_STATUSES.join(', ')}`,
        });
        return;
      }

      const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? ''), 10) || 25));

      let from: Date | undefined;
      let to: Date | undefined;
      if (typeof req.query.from === 'string' && req.query.from) {
        from = new Date(req.query.from);
        if (Number.isNaN(from.getTime())) {
          res.status(400).json({ status: 'error', message: 'from must be a valid ISO timestamp.' });
          return;
        }
      }
      if (typeof req.query.to === 'string' && req.query.to) {
        to = new Date(req.query.to);
        if (Number.isNaN(to.getTime())) {
          res.status(400).json({ status: 'error', message: 'to must be a valid ISO timestamp.' });
          return;
        }
      }

      try {
        const result = await service.listVoicemailCallbackAlerts(
          page,
          pageSize,
          rawStatus as VoicemailCallbackAlertStatus | undefined,
          from,
          to,
        );
        res.json({ status: 'success', ...result });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── Telecom Agent Metrics ────────────────────────────────────────────────────
  //
  // GET /telecom/agents/metrics
  //
  // Returns per-agent call metrics aggregated from st_calls_v3_enrichment.
  // Calls with no agent attribution appear as a separate row with agentId = null.
  //
  // Query parameters:
  //   from, to    — ISO date/datetime (UTC) filter on call_received_on (optional)
  //   agentId     — filter to a single agent (optional; omit to return all agents)
  //   page        — 1-based page number (default: 1)
  //   pageSize    — 1–100 (default: 25)
  //
  // Metrics returned per agent:
  //   totalCalls, inboundCalls, outboundCalls, abandonedCalls,
  //   totalDurationSeconds, avgDurationSeconds, firstCallAt, lastCallAt
  //
  // Data limitations:
  //   - Duration is derived from V3 ISO-8601 duration strings; null durations excluded.
  //   - No live availability, booking rate or revenue-per-agent (requires Dialpad).
  //   - abandonedCalls counts ST-classified 'Abandoned' calls only.
  router.get(
    '/telecom/agents/metrics',
    callDetailsRateLimiter,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { page, pageSize } = pagination(req);
        const agentIdParam = req.query['agentId'];
        const agentId = typeof agentIdParam === 'string' && agentIdParam.trim() !== ''
          ? agentIdParam.trim()
          : undefined;

        let from: Date | undefined;
        let to: Date | undefined;
        if (req.query['from']) {
          from = new Date(String(req.query['from']));
          if (isNaN(from.getTime())) {
            res.status(400).json({ status: 'error', message: 'Invalid "from" timestamp. Must be ISO 8601 UTC.' });
            return;
          }
        }
        if (req.query['to']) {
          to = new Date(String(req.query['to']));
          if (isNaN(to.getTime())) {
            res.status(400).json({ status: 'error', message: 'Invalid "to" timestamp. Must be ISO 8601 UTC.' });
            return;
          }
        }

        // Default to current calendar month (UTC) when no range is given.
        const now = new Date();
        const effectiveFrom = from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const effectiveTo = to ?? now;

        const data = await service.getAgentMetrics(effectiveFrom, effectiveTo, page, pageSize, agentId);
        res.json({ status: 'success', data });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── Abandoned inbound calls — D-02 reporting ────────────────────────────────
  //
  // GET /telecom/calls/abandoned
  //   Returns paginated ServiceTitan-classified abandoned inbound calls.
  //   "Abandoned" = call_type='Abandoned' AND direction='Inbound' in ST's taxonomy.
  //   This is NOT equivalent to all missed-call scenarios; ring-level missed calls
  //   require a Dialpad integration.
  //
  // Query parameters:
  //   from, to       — ISO date/datetime (UTC). Default: current calendar month.
  //   page           — 1-based page number (default: 1).
  //   pageSize       — 1–100 (default: 25).
  //   sort           — 'asc' | 'desc' by call_received_on (default: 'desc').
  //
  // GET /telecom/calls/abandoned/aggregate
  //   Returns summary counts and breakdowns by day and hour (UTC).
  //   No pagination — covers the full date range in a single response.
  //
  // Both endpoints access telecom data — callDetailsRateLimiter applies.
  // Phone numbers, raw payloads, and recording/voicemail URLs are never returned.

  router.get(
    '/telecom/calls/abandoned',
    callDetailsRateLimiter,
    async (_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      const req = _req as unknown as Request;
      const { from, to } = parseDateRangeFilter(req);
      const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? ''), 10) || 25));
      const rawSort = typeof req.query.sort === 'string' ? req.query.sort.toLowerCase() : 'desc';
      const sortDir: 'asc' | 'desc' = rawSort === 'asc' ? 'asc' : 'desc';

      try {
        const data = await service.listAbandonedCalls(from, to, page, pageSize, sortDir);
        res.json({ status: 'success', ...data });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/telecom/calls/abandoned/aggregate',
    callDetailsRateLimiter,
    async (_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      const req = _req as unknown as Request;
      const { from, to } = parseDateRangeFilter(req);

      try {
        const data = await service.getAbandonedCallsAggregate(from, to);
        res.json({ status: 'success', data });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/jobs', async (req, res, next) => {
    try {
      const { page, pageSize } = pagination(req);
      const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
      res.json({ status: 'success', ...(await service.listJobs(page, pageSize, status)) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/invoices', async (req, res, next) => {
    try {
      const { page, pageSize } = pagination(req);
      const raw = typeof req.query.classification === 'string' ? req.query.classification.toUpperCase() : undefined;
      if (raw && !(INVOICE_CLASSIFICATIONS as readonly string[]).includes(raw)) {
        res.status(400).json({ status: 'error', message: `classification must be one of ${INVOICE_CLASSIFICATIONS.join(', ')}` });
        return;
      }
      res.json({ status: 'success', ...(await service.listInvoices(page, pageSize, raw as StInvoiceListItem['classification'] | undefined)) });
    } catch (err) {
      next(err);
    }
  });

  // ─── Individual call details ─────────────────────────────────────────────────
  //
  // GET /telecom/calls/:callId
  //
  // Returns structured call metadata from ServiceTitan V2. Requires a valid session.
  // Sensitive fields (phone numbers, recording/voicemail URLs) are stripped server-side.
  router.get(
    '/telecom/calls/:callId',
    callDetailsRateLimiter,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      const callId = String(req.params['callId'] ?? '');

      if (!callId || !CALL_ID_RE.test(callId)) {
        res.status(400).json({ status: 'error', message: 'Invalid call ID.' });
        return;
      }

      try {
        const data = await callDetailsService.getCallDetails(callId);
        res.json({ status: 'success', data });
      } catch (err) {
        if (err instanceof CallDetailsUpstreamError) {
          res.status(err.statusCode).json({ status: 'error', message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // ─── Authenticated recording proxy ───────────────────────────────────────────
  //
  // GET /telecom/calls/:callId/recording
  //
  // Requires a valid session. Validates the call ID, confirms the call exists and has
  // a recording URL in the stored payload (no ST API call required for these checks),
  // then streams the audio directly from ServiceTitan to the response without buffering.
  router.get(
    '/telecom/calls/:callId/recording',
    recordingRateLimiter,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      const callId = String(req.params['callId'] ?? '');

      if (!callId || !CALL_ID_RE.test(callId)) {
        res.status(400).json({ status: 'error', message: 'Invalid call ID.' });
        return;
      }

      const eligibility = await recordingService.checkEligibility(callId).catch((err: unknown) => {
        next(err);
        return null;
      });
      if (eligibility === null) return;

      if (eligibility === 'not_found') {
        res.status(404).json({ status: 'error', message: 'Call not found.' });
        return;
      }
      if (eligibility === 'no_recording') {
        res.status(404).json({ status: 'error', message: 'No recording available for this call.' });
        return;
      }

      // Abort the ST request when the client disconnects or the timeout fires.
      // Use res.on('close') — req fires 'close' almost immediately on GET requests
      // (no body to consume), which would abort the upstream fetch before it starts.
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), ST_RECORDING_TIMEOUT_MS);
      res.on('close', () => { if (!res.writableFinished) abortController.abort(); });

      let recordingStream;
      try {
        recordingStream = await recordingService.fetchStream(callId, abortController.signal);
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (err instanceof RecordingUpstreamError) {
          res.status(err.statusCode).json({ status: 'error', message: err.message });
          return;
        }
        next(err);
        return;
      }

      clearTimeout(timeoutHandle);

      // Set response headers before piping — once the stream starts we cannot change them.
      res.set('Content-Type', recordingStream.contentType);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', 'inline');
      if (recordingStream.contentLength) {
        res.set('Content-Length', recordingStream.contentLength);
      }
      res.status(200);

      const nodeStream = Readable.fromWeb(recordingStream.body as Parameters<typeof Readable.fromWeb>[0]);

      nodeStream.on('error', (err: NodeJS.ErrnoException) => {
        const isClientGone = err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET';
        if (!isClientGone) {
          logger.warn('[RecordingProxy] Stream pipe error', { callId, error: err.message });
        }
        if (!res.headersSent) {
          next(err);
        } else {
          res.destroy();
        }
      });

      res.on('error', () => nodeStream.destroy());

      nodeStream.pipe(res);

      // Log after the stream ends — only metadata, no tokens, URLs or audio.
      nodeStream.on('end', () => {
        logger.info('[RecordingProxy] Recording stream complete', {
          callId,
          sessionId: req.auth?.sessionId,
          contentType: recordingStream.contentType,
        });
      });
    },
  );

  // ─── Authenticated voicemail proxy ───────────────────────────────────────────
  //
  // GET /telecom/calls/:callId/voicemail
  //
  // Requires a valid session. Validates the call ID, then streams the voicemail audio
  // directly from ServiceTitan without buffering. A 404 from the API means no voicemail
  // exists for this call — no DB check is performed.
  router.get(
    '/telecom/calls/:callId/voicemail',
    recordingRateLimiter,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      const callId = String(req.params['callId'] ?? '');

      if (!callId || !CALL_ID_RE.test(callId)) {
        res.status(400).json({ status: 'error', message: 'Invalid call ID.' });
        return;
      }

      // Abort the ST request when the client disconnects or the timeout fires.
      // Use res.on('close') — req fires 'close' almost immediately on GET requests
      // (no body to consume), which would abort the upstream fetch before it starts.
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), ST_RECORDING_TIMEOUT_MS);
      res.on('close', () => { if (!res.writableFinished) abortController.abort(); });

      let voicemailStream;
      try {
        voicemailStream = await recordingService.fetchVoicemailStream(callId, abortController.signal);
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (err instanceof RecordingUpstreamError) {
          res.status(err.statusCode).json({ status: 'error', message: err.message });
          return;
        }
        next(err);
        return;
      }

      clearTimeout(timeoutHandle);

      // Set response headers before piping — once the stream starts we cannot change them.
      res.set('Content-Type', voicemailStream.contentType);
      res.set('Cache-Control', 'private, no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', 'inline');
      if (voicemailStream.contentLength) {
        res.set('Content-Length', voicemailStream.contentLength);
      }
      res.status(200);

      const nodeStream = Readable.fromWeb(voicemailStream.body as Parameters<typeof Readable.fromWeb>[0]);

      nodeStream.on('error', (err: NodeJS.ErrnoException) => {
        const isClientGone = err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET';
        if (!isClientGone) {
          logger.warn('[VoicemailProxy] Stream pipe error', { callId, error: err.message });
        }
        if (!res.headersSent) {
          next(err);
        } else {
          res.destroy();
        }
      });

      res.on('error', () => nodeStream.destroy());

      nodeStream.pipe(res);

      nodeStream.on('end', () => {
        logger.info('[VoicemailProxy] Voicemail stream complete', {
          callId,
          sessionId: req.auth?.sessionId,
          contentType: voicemailStream.contentType,
        });
      });
    },
  );

  // GET /telecom/calls/:callId/revenue
  //
  // Returns call-to-revenue attribution for a single ServiceTitan call.
  //
  // Attribution chain: raw_st_calls.st_job_id → raw_st_invoices (payload->'job'->>'id')
  // This is the ONLY defensible attribution path. Calls with no job ID receive
  // attributionStatus = 'NO_JOB'; customer-level revenue is NOT attributed.
  //
  // Response fields:
  //   attributionStatus  — JOB_LINKED | NO_JOB | NO_LINKAGE
  //   attributionMethod  — call_job_invoice | none
  //   customerId         — ST customer ID (context only, not the revenue basis)
  //   jobId              — ST job ID (the linkage anchor; null if none)
  //   linkedInvoiceCount — active invoices found for the job (0 if no job)
  //   invoicedAmount     — SUM(invoice.total) for the job's active invoices
  //   outstandingBalance — SUM(invoice.balance) for the job's active invoices
  //   currency           — 'USD' when invoices are present; null otherwise
  //
  // No PII is returned — no phone numbers, recording URLs, or customer names.
  router.get(
    '/telecom/calls/:callId/revenue',
    callDetailsRateLimiter,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
      const callId = String(req.params['callId'] ?? '');

      if (!callId || !CALL_ID_RE.test(callId)) {
        res.status(400).json({ status: 'error', message: 'Invalid call ID.' });
        return;
      }

      try {
        const data = await service.getCallRevenueAttribution(callId);
        res.json({ status: 'success', data });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
};

export const serviceTitanReportingRouter = createServiceTitanReportingRouter();
