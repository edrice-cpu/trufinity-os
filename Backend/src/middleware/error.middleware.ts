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

  res.status(500).json({
    status: 'error',
    message: 'Internal Server Error',
  });
};

export const notFoundHandler = (req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    message: `Not Found - ${req.originalUrl}`,
  });
};
