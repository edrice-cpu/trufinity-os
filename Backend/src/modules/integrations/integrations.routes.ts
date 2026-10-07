import { Router } from 'express';
import { createRequireAuth } from '../auth/auth.middleware';
import { authService as defaultAuthService, type AuthService } from '../auth/auth.service';
import { integrationsService as defaultIntegrationsService, type IntegrationsService } from './integrations.service';

// Auth is applied per route: this router shares the /api/integrations prefix with the public QuickBooks OAuth callback.
export const createIntegrationsRouter = (
  integrationsService: IntegrationsService = defaultIntegrationsService,
  authService: AuthService = defaultAuthService,
): Router => {
  const router = Router();
  const requireAuth = createRequireAuth(authService);

  router.get('/status', requireAuth, async (_req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.status(200).json({ status: 'ok', ...(await integrationsService.getStatus()) });
    } catch (error) {
      next(error);
    }
  });

  // POST because it creates single-use OAuth state; the frontend then sends the browser to the returned URL.
  router.post('/quickbooks/connect', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.status(200).json({ status: 'ok', authorizationUrl: integrationsService.getQuickBooksConnectUrl() });
    } catch {
      res.status(503).json({ status: 'error', message: 'QuickBooks is not configured on the server.' });
    }
  });

  return router;
};

export const integrationsRouter = createIntegrationsRouter();
