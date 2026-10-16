import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  // Full diagnostics go to the server log (SQL, stack traces, filesystem paths).
  // None of this is forwarded to the HTTP client in any environment.
  logger.error(`Error: ${err.message}`, { stack: err.stack });

  const statusCode = typeof (err as Error & { statusCode?: unknown }).statusCode === 'number'
    ? (err as Error & { statusCode: number }).statusCode : 500;
  const code = typeof (err as Error & { code?: unknown }).code === 'string'
    ? (err as Error & { code: string }).code : undefined;
  res.status(statusCode).json({
    status: 'error',
    ...(code !== undefined ? { code } : {}),
    message: statusCode === 503 && code === 'R05_BACKFILL_INCOMPLETE'
      ? 'R-05 aging queue is temporarily unavailable while thread state backfill completes.'
      : 'Internal Server Error',
  });
};

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    message: `Not Found - ${req.originalUrl}`,
  });
};
