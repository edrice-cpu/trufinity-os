import { Router, type Request, type RequestHandler } from 'express';
import { serviceTitanReportingService as service } from './servicetitan-reporting.service';
import { parseDateRangeFilter, parseDepartmentFilter } from '../../utils/dashboard-filters';
import type { StInvoiceListItem } from './servicetitan-reporting.types';

const router = Router();

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

export const serviceTitanReportingRouter = router;
