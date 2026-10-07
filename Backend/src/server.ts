import app from './app';
import { env } from './config/env';
import { logger } from './utils/logger';
import { db } from './database';
import { startLaceScheduler } from './modules/lace/lace.scheduler';
import { startServiceTitanScheduler } from './modules/servicetitan/servicetitan.scheduler';

const startServer = async (): Promise<void> => {
  try {
    await db.raw('SELECT 1');
    logger.info(`Database connection established (${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME})`);
    app.listen(env.PORT, () => {
      logger.info(`Server is running in ${env.NODE_ENV} mode on port ${env.PORT}`);
      logger.info(`Health check: http://localhost:${env.PORT}/health`);
    });
    startLaceScheduler();
    startServiceTitanScheduler();
  } catch {
    logger.error(`Database connection failed (${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}); server startup aborted`);
    await db.destroy().catch(() => undefined);
    process.exitCode = 1;
  }
};

void startServer();
