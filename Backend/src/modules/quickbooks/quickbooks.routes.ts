import { Router, Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { qboAuthService } from './auth.service';
import { qboApiClient } from './api.client';
import { qboCompanyInfoService } from './services/companyinfo.service';
import { qboCustomerService } from './services/customer.service';
import { qboInvoiceService } from './services/invoice.service';
import { qboPaymentService } from './services/payment.service';
import { qboAccountService } from './services/account.service';
import { qboCreditMemoService } from './services/creditmemo.service';
import { logger } from '../../utils/logger';
import { timingSafeEqual } from 'node:crypto';

const router = Router();

interface CompanyInfoApiResponse {
  CompanyInfo?: {
    CompanyName?: string;
  };
}

// Diagnostic/data routes remain development-only until application authentication is added.
const devOnly = (_req: Request, res: Response, next: NextFunction) => {
  if (env.NODE_ENV !== 'development') {
    res.status(403).json({ error: 'Integration endpoints are only available in development mode' });
    return;
  }
  next();
};

const requireDisconnectAuthorization = (req: Request, res: Response, next: NextFunction): void => {
  const expected = env.QBO_DISCONNECT_AUTH_TOKEN;
  const authorization = req.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const supplied = match?.[1] ?? '';

  if (!expected || Buffer.byteLength(expected, 'utf8') < 32) {
    res.status(503).json({ status: 'error', message: 'QuickBooks disconnect is not configured.' });
    return;
  }

  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  const authorized = suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
  if (!authorized) {
    res.status(401).json({ status: 'error', message: 'Unauthorized.' });
    return;
  }

  next();
};

// 1. Generate Auth URL and redirect user to Intuit
router.get('/authorize', (_req, res) => {
  const authUrl = qboAuthService.getAuthorizationUrl();
  logger.info('[QuickBooks] Redirecting to Intuit for Authorization');
  res.redirect(authUrl);
});

// Flows started from the web app return to its Integrations page instead of receiving JSON.
const redirectToApp = (res: Response, result: 'connected' | 'denied' | 'failed'): void => {
  res.redirect(303, `${env.APP_BASE_URL}/integrations?quickbooks=${result}`);
};

// 2. Handle Intuit Callback, exchange token, and verify connection
router.get('/callback', async (req, res, next) => {
  let returnToApp = false;
  try {
    const code = req.query.code as string;
    const realmId = req.query.realmId as string;
    const state = req.query.state as string;
    const error = req.query.error as string;

    const pendingState = state ? qboAuthService.consumeAuthorizationState(state) : null;
    if (!pendingState) {
      res.status(400).json({ status: 'error', message: 'Invalid or expired OAuth state.' });
      return;
    }
    returnToApp = pendingState.returnToApp;

    if (error) {
      logger.error('[QuickBooks] Authorization failed');
      if (returnToApp) { redirectToApp(res, 'denied'); return; }
      res.status(400).json({ status: 'error', message: 'User denied authorization or an error occurred.' });
      return;
    }

    if (!code || !realmId) {
      if (returnToApp) { redirectToApp(res, 'failed'); return; }
      res.status(400).json({ status: 'error', message: 'Missing code or realmId in callback query.' });
      return;
    }

    // Exchange the authorization code for tokens
    await qboAuthService.exchangeCodeForToken(code, realmId);

    // Verify connection by calling CompanyInfo
    logger.info('[QuickBooks] Verifying connection via CompanyInfo API');
    const companyInfoResponse = await qboApiClient.get<CompanyInfoApiResponse>(`/v3/company/${realmId}/companyinfo/${realmId}`);

    if (returnToApp) { redirectToApp(res, 'connected'); return; }
    res.json({
      status: 'success',
      message: 'QuickBooks OAuth connected successfully!',
      company: companyInfoResponse.CompanyInfo?.CompanyName ?? 'Unknown Company'
    });
  } catch (err) {
    if (returnToApp) {
      logger.error('[QuickBooks] OAuth callback failed');
      redirectToApp(res, 'failed');
      return;
    }
    next(err);
  }
});

// Never allow a browser/crawler GET to revoke the production connection.
router.get('/disconnect', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ status: 'error', message: 'Use an authorized POST request to disconnect QuickBooks.' });
});

// Intuit disconnect/revoke endpoint. Requires a server-configured admin bearer secret.
router.post('/disconnect', requireDisconnectAuthorization, async (_req, res, next) => {
  try {
    const disconnected = await qboAuthService.disconnect();
    res.json({
      status: 'success',
      message: disconnected ? 'QuickBooks disconnected successfully.' : 'No QuickBooks connection was found.',
    });
  } catch (err) {
    next(err);
  }
});

// Diagnostic/data routes are not exposed when NODE_ENV=production.
router.use(devOnly);

// Data Services (Diagnostic)
router.get('/companyinfo', async (_req, res, next) => {
  try {
    const data = await qboCompanyInfoService.getCompanyInfo();
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
});

router.get('/customers', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
    const data = await qboCustomerService.getCustomers(limit);
    res.json({ status: 'success', limit, count: data.length, data });
  } catch (err) {
    next(err);
  }
});

router.get('/invoices', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
    const data = await qboInvoiceService.getInvoices(limit);
    res.json({ status: 'success', limit, count: data.length, data });
  } catch (err) {
    next(err);
  }
});

router.get('/payments', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
    const data = await qboPaymentService.getPayments(limit);
    res.json({ status: 'success', limit, count: data.length, data });
  } catch (err) {
    next(err);
  }
});

router.get('/accounts', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
    const data = await qboAccountService.getAccounts(limit);
    res.json({ status: 'success', limit, count: data.length, data });
  } catch (err) {
    next(err);
  }
});

router.get('/creditmemos', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;
    const data = await qboCreditMemoService.getCreditMemos(limit);
    res.json({ status: 'success', limit, count: data.length, data });
  } catch (err) {
    next(err);
  }
});

export const quickbooksRouter = router;
