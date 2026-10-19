import { Router } from 'express';
import { createRequireAuth } from '../auth/auth.middleware';
import { authService as defaultAuthService, type AuthService } from '../auth/auth.service';
import { getLaceFreshness } from '../lace/lace-freshness';

const routes = Router();

// Health of each Lace AI feed (call analysis, agent performance): last run,
// last successful sync, consecutive failures, when the last Lace file arrived,
// the newest data date, and an OK / STALE / FAILING / NO_DATA status. Feeds the
// brief header's per-source freshness line (SPEC-BI-001 Section 7) - a failing
// or stale feed must be shown, never presented as complete.
routes.get('/sync-status', async (_req, res, next) => {
  try {
    res.json({ status: 'success', data: await getLaceFreshness() });
  } catch (err) {
    next(err);
  }
});

// Every Lace reporting route needs a signed-in session (SPEC-BI-001 Section
// 11). 401 { status: 'error', message } otherwise, from createRequireAuth.
export const createLaceReportingRouter = (authService: AuthService = defaultAuthService): Router => {
  const router = Router();
  router.use(createRequireAuth(authService));
  router.use(routes);
  return router;
};

export const laceReportingRouter = createLaceReportingRouter();
