import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { healthRouter } from './modules/health/health.routes';
import { quickbooksRouter } from './modules/quickbooks/quickbooks.routes';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { serviceTitanRouter } from './modules/servicetitan/servicetitan.routes';
import { laceRouter } from './modules/lace/lace.routes';
import { detectRouter } from './modules/detect/detect.routes';
import { narrateRouter } from './modules/narrate/narrate.routes';
import { deliverRouter } from './modules/deliver/deliver.routes';
import { reportingRouter } from './modules/reporting/reporting.routes';
import { serviceTitanReportingRouter } from './modules/reporting/servicetitan-reporting.routes';
import { authRouter } from './modules/auth/auth.routes';
import { integrationsRouter } from './modules/integrations/integrations.routes';
import { googleRouter } from './modules/google/google.routes';
import { env } from './config/env';

const app = express();

// Required behind a reverse proxy (or the frontend BFF) so rate limiting sees real client IPs.
app.set('trust proxy', env.TRUST_PROXY);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging excludes query strings so OAuth authorization codes are not logged.
app.use(morgan((tokens, req, res) => [
  tokens.method(req, res),
  req.path,
  tokens.status(req, res),
  tokens.res(req, res, 'content-length'),
  '-',
  tokens['response-time'](req, res),
  'ms',
].join(' ')));

// API Routes
app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
// Must precede the provider routers, whose dev-only guards would otherwise catch these paths.
app.use('/api/integrations', integrationsRouter);
app.use('/api/integrations/servicetitan', serviceTitanRouter);
app.use('/api/integrations/quickbooks', quickbooksRouter);
app.use('/api/integrations/lace', laceRouter);
app.use('/api/detect', detectRouter);
app.use('/api/narrate', narrateRouter);
app.use('/api/brief', deliverRouter);
app.use('/api/reporting/quickbooks', reportingRouter);
app.use('/api/reporting/servicetitan', serviceTitanReportingRouter);
app.use('/api/google', googleRouter);

// Handle 404
app.use(notFoundHandler);

// Centralized error handling
app.use(errorHandler);

export default app;
