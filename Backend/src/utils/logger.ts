import winston from 'winston';
import { env } from '../config/env';

// splat lets winston collect the extra metadata argument (logger.info('msg', { foo })
// -> info.metadata) instead of silently dropping it; printf must then render it, or
// every call site's metadata (sync results, error details, ...) never reaches the logs.
const formats = [
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.splat(),
  winston.format.metadata({ fillExcept: ['timestamp', 'level', 'message'] }),
  winston.format.printf((info) => {
    const metadata = info.metadata as Record<string, unknown> | undefined;
    const hasMetadata = metadata !== undefined && Object.keys(metadata).length > 0;
    const suffix = hasMetadata ? ` ${JSON.stringify(metadata)}` : '';
    return `${String(info.timestamp)} ${String(info.level)}: ${String(info.message)}${suffix}`;
  }),
];

if (env.NODE_ENV === 'development') {
  formats.unshift(winston.format.colorize({ all: true }));
}

export const logger = winston.createLogger({
  // 'warn' in production would silence every info-level completion log
  // (Lace sync results, canonical-sync results, ...) - only genuine problems
  // should be quieter than that, not routine operational visibility.
  level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  levels: winston.config.npm.levels,
  format: winston.format.combine(...formats),
  transports: [
    new winston.transports.Console(),
    // We can add File transports here for production
  ],
});
