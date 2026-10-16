import type { NextFunction, Request, Response } from 'express';
import { authService as defaultAuthService, type AuthService } from './auth.service';
import { normalizeEmail, type AuthenticatedSession } from './auth.types';

export type AuthenticatedRequest = Request & { auth?: AuthenticatedSession };

export const bearerToken = (req: Request): string => {
  const match = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(req.get('authorization') ?? '');
  return match?.[1] ?? '';
};

export const createRequireAuth = (authService: AuthService = defaultAuthService) =>
  async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const session = await authService.authenticate(bearerToken(req));
    if (!session) {
      res.status(401).json({ status: 'error', message: 'Authentication required.' });
      return;
    }
    req.auth = session;
    next();
  };

export const requireAuth = createRequireAuth();

/**
 * Restricts a route to one server-configured client identity. This middleware
 * must run after requireAuth so the compared email comes from the authenticated
 * session, never from a request parameter or header.
 */
export const createRequireClientOnly = (allowedEmail: string) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ status: 'error', message: 'Authentication required.' });
      return;
    }
    if (normalizeEmail(req.auth.user.email) !== normalizeEmail(allowedEmail)) {
      res.status(403).json({ status: 'error', message: 'Google Workspace access is restricted to the authorized client.' });
      return;
    }
    next();
  };
