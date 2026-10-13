import { Router } from 'express';
import { createRequireAuth } from '../auth/auth.middleware';
import { authService as defaultAuthService, type AuthService } from '../auth/auth.service';
import { reportingService } from './reporting.service';
import { parseDateRangeFilter } from '../../utils/dashboard-filters';

const routes = Router();

// Full dashboard snapshot in one call — invoices, payments, and data-quality metrics.
routes.get('/summary', async (_req, res, next) => {
  try {
    const data = await reportingService.getSnapshot();
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

// Invoice KPIs: totals, AR outstanding, paid/unpaid/partially-paid breakdown.
// Date filter (default month-to-date): ?from=2026-09-01&to=2026-09-30.
routes.get('/invoices/summary', async (req, res, next) => {
  try {
    const data = await reportingService.getInvoiceSummary(parseDateRangeFilter(req));
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

// Payment KPIs: totals, applied/unapplied amounts, reconciliation status.
// Date filter (default month-to-date): ?from=2026-09-01&to=2026-09-30.
routes.get('/payments/summary', async (req, res, next) => {
  try {
    const data = await reportingService.getPaymentSummary(parseDateRangeFilter(req));
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

// Sync/data-quality health per entity (Customer/Invoice/Payment): raw vs. mapped counts, broken links.
routes.get('/completeness', async (_req, res, next) => {
  try {
    const data = await reportingService.getQboCompleteness();
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

// ServiceTitan <-> QuickBooks customer identity match quality.
routes.get('/customer-identity-quality', async (_req, res, next) => {
  try {
    const data = await reportingService.getCustomerIdentityQuality();
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

// Payment-to-invoice application integrity: orphans, duplicates, stale identities.
routes.get('/payment-application-integrity', async (_req, res, next) => {
  try {
    const data = await reportingService.getPaymentApplicationIntegrity();
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

// Every QuickBooks reporting route needs a signed-in session: these are
// company financials (SPEC-BI-001 Section 11). 401 { status: 'error', message }
// otherwise, from createRequireAuth.
export const createReportingRouter = (authService: AuthService = defaultAuthService): Router => {
  const router = Router();
  router.use(createRequireAuth(authService));
  router.use(routes);
  return router;
};

export const reportingRouter = createReportingRouter();
