import type { FastifyServerOptions } from 'fastify';
import { env } from './env.js';

const sensitivePaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  '*.authorization',
  '*.cookie',
  '*.set-cookie',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.api_key',
  '*.license',
  '*.licenseCode',
  '*.JWT_ACCESS_SECRET',
  '*.JWT_REFRESH_SECRET',
  '*.ADMIN_API_KEY_HASH',
  '*.DATABASE_URL',
  '*.POSTGRES_PASSWORD',
];

export const loggerOptions: NonNullable<FastifyServerOptions['logger']> = {
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: sensitivePaths,
    censor: '[REDACTED]',
  },
};
