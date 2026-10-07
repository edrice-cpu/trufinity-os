import { Router, Request, Response } from 'express';
import { db } from '../../database';
import { logger } from '../../utils/logger';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    // Basic DB ping to check connection
    await db.raw('SELECT 1 as result');
    
    res.status(200).json({
      status: 'ok',
      message: 'Backend is healthy and database is reachable',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Health check failed', error);
    res.status(503).json({
      status: 'error',
      message: 'Database connection failed',
      timestamp: new Date().toISOString(),
    });
  }
});

export const healthRouter = router;
