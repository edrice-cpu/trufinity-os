import type { NextFunction, Request, Response } from 'express';
import { authService as defaultAuthService, type AuthService } from './auth.service';
import type { AuthenticatedSession } from './auth.types';

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
