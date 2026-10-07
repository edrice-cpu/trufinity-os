import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { ZodType } from 'zod';
import { logger } from '../../utils/logger';
import { bearerToken, createRequireAuth, type AuthenticatedRequest } from './auth.middleware';
import { AuthError, authService as defaultAuthService, type AuthService } from './auth.service';
import { forgotPasswordSchema, loginSchema, resetPasswordSchema, type RequestContext } from './auth.types';

export const FORGOT_PASSWORD_RESPONSE_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

const tooManyRequests = (message: string) => ({ status: 'error', message });

const limiter = (windowMinutes: number, limit: number, message: string) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooManyRequests(message),
});

const requestContext = (req: Request): RequestContext => ({
  ipAddress: req.ip ?? null,
  userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
});

const parseBody = <T>(schema: ZodType<T>, req: Request, res: Response): T | undefined => {
  const result = schema.safeParse(req.body ?? {});
  if (result.success) return result.data;
  res.status(400).json({
    status: 'error',
    message: 'Validation failed.',
    errors: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  });
  return undefined;
};

export const createAuthRouter = (authService: AuthService = defaultAuthService): Router => {
  const router = Router();

  // Credentials and tokens must never be cached by browsers or intermediaries.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    next();
  });

  const requireAuth = createRequireAuth(authService);

  const handleAuthError = (error: unknown, res: Response, next: NextFunction): void => {
    if (error instanceof AuthError) {
      res.status(error.statusCode).json({ status: 'error', message: error.message });
      return;
    }
    next(error);
  };

  router.post(
    '/login',
    limiter(15, 20, 'Too many sign-in attempts. Please try again later.'),
    async (req, res, next) => {
      const body = parseBody(loginSchema, req, res);
      if (!body) return;
      try {
        const session = await authService.login(body.email, body.password, requestContext(req));
        res.status(200).json({
          status: 'ok',
          token: session.token,
          expiresAt: session.expiresAt.toISOString(),
          user: session.user,
        });
      } catch (error) {
        handleAuthError(error, res, next);
      }
    },
  );

  router.post('/logout', async (req, res, next) => {
    try {
      await authService.logout(bearerToken(req));
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.status(200).json({ status: 'ok', user: req.auth?.user });
  });

  router.post(
    '/forgot-password',
    limiter(15, 5, 'Too many password reset requests. Please try again later.'),
    (req, res) => {
      const body = parseBody(forgotPasswordSchema, req, res);
      if (!body) return;

      // Respond before doing any lookup or email work so timing does not reveal whether the account exists.
      res.status(202).json({ status: 'ok', message: FORGOT_PASSWORD_RESPONSE_MESSAGE });
      authService.requestPasswordReset(body.email, requestContext(req)).catch((error: unknown) => {
        logger.error(`[Auth] Password reset request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
    },
  );

  router.post(
    '/reset-password',
    limiter(15, 10, 'Too many password reset attempts. Please try again later.'),
    async (req, res, next) => {
      const body = parseBody(resetPasswordSchema, req, res);
      if (!body) return;
      try {
        await authService.resetPassword(body.token, body.password);
        res.status(200).json({ status: 'ok', message: 'Your password has been reset. You can now sign in.' });
      } catch (error) {
        handleAuthError(error, res, next);
      }
    },
  );

  return router;
};

export const authRouter = createAuthRouter();
