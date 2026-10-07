import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

// Gates a router to development only (manual test-trigger endpoints for
// integrations that otherwise run on a schedule). Each route keeps its own
// error message via `message` so existing API responses don't change.
export function devOnlyMiddleware(message = 'Integration test endpoints are only available in development mode') {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (env.NODE_ENV !== 'development') {
      res.status(403).json({ error: message });
      return;
    }
    next();
  };
}
