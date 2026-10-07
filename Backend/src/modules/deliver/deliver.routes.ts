import { Router } from 'express';
import { deliverService } from './deliver.service';
import { parseDateRangeFilter } from '../../utils/dashboard-filters';

const router = Router();

// Date filter (default month-to-date, on when the alert was detected):
// ?from=2026-09-01&to=2026-09-30. No Department filter - Lace's data has no
// department/business-unit dimension.
router.get('/alerts', async (req, res, next) => {
  try {
    const filters = {
      ...(typeof req.query.ruleCode === 'string' ? { ruleCode: req.query.ruleCode } : {}),
      dateRange: parseDateRangeFilter(req),
    };
    const alerts = await deliverService.listAlerts(filters);
    // Same envelope as the rest of the API: { status: 'success', data } on
    // success, { status: 'error', message } on failure (see quickbooks.routes.ts
    // and error.middleware.ts).
    res.json({ status: 'success', data: alerts });
  } catch (err) {
    next(err);
  }
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/alerts/:id', async (req, res, next) => {
  try {
    // A non-UUID id can never match a row; without this Postgres rejects the
    // query ("invalid input syntax for type uuid") and the client gets a 500
    // instead of the documented 404.
    if (!UUID_PATTERN.test(req.params.id)) {
      res.status(404).json({ status: 'error', message: 'Alert not found' });
      return;
    }
    const alert = await deliverService.getAlertById(req.params.id);
    if (!alert) {
      res.status(404).json({ status: 'error', message: 'Alert not found' });
      return;
    }
    res.json({ status: 'success', data: alert });
  } catch (err) {
    next(err);
  }
});

export const deliverRouter = router;
