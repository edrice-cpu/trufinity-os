import { Router, type Request, type RequestHandler } from 'express';
import { createRequireAuth } from '../auth/auth.middleware';
import { authService as defaultAuthService, type AuthService } from '../auth/auth.service';
import { serviceTitanReportingService as service } from './servicetitan-reporting.service';
import { parseDateRangeFilter, parseDepartmentFilter } from '../../utils/dashboard-filters';
import type { StInvoiceListItem } from './servicetitan-reporting.types';

const routes = Router();

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

routes.get('/summary', simple(() => service.getSnapshot()));
// Date (default month-to-date) and Department (default "Company") filters -
// e.g. ?from=2026-09-01&to=2026-09-30&department=Service.
routes.get('/jobs/summary', async (req, res, next) => {
  try {
    const data = await service.getJobsSummary(parseDateRangeFilter(req), parseDepartmentFilter(req));
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});
routes.get('/invoices/summary', simple(() => service.getInvoicesSummary()));
routes.get('/invoices/ar-aging', simple(() => service.getArAging()));
routes.get('/payments/summary', simple(() => service.getPaymentsSummary()));
routes.get('/leads-bookings/summary', simple(() => service.getLeadsBookingsSummary()));
routes.get('/appointments/summary', simple(() => service.getAppointmentsSummary()));
routes.get('/customers/summary', simple(() => service.getCustomersSummary()));
routes.get('/technicians/summary', simple(() => service.getTechnicianSummary()));
routes.get('/sync-status', simple(() => service.getSyncStatus()));

routes.get('/jobs', async (req, res, next) => {
  try {
    const { page, pageSize } = pagination(req);
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    res.json({ status: 'success', ...(await service.listJobs(page, pageSize, status)) });
  } catch (err) {
    next(err);
  }
});

routes.get('/invoices', async (req, res, next) => {
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

// Every ServiceTitan reporting route needs a signed-in session: AR, revenue
// and technician sales are confidential (SPEC-BI-001 Section 11). 401
// { status: 'error', message } otherwise, from createRequireAuth.
export const createServiceTitanReportingRouter = (authService: AuthService = defaultAuthService): Router => {
  const router = Router();
  router.use(createRequireAuth(authService));
  router.use(routes);
  return router;
};

export const serviceTitanReportingRouter = createServiceTitanReportingRouter();
