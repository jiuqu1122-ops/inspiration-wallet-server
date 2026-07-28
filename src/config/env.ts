import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const defaultLicenseSigningPublicKey = 'AAS4rzI5dxFefYmQCNp1wYpYgKwMXp5+wG1WgF/UoRQ=';

function isCanonicalEd25519PublicKey(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

function isBase64Encoded32ByteKey(value: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

const secretSchema = z
  .string()
  .min(32, 'must contain at least 32 characters')
  .refine((value) => !value.startsWith('CHANGE_ME'), 'must not use the example placeholder');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    APP_BASE_URL: z.url(),
    DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: secretSchema,
    JWT_REFRESH_SECRET: secretSchema,
    JWT_ACCESS_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/, 'must look like 15m or 30d').default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/, 'must look like 15m or 30d').default('30d'),
    LICENSE_SIGNING_PUBLIC_KEY: z
      .string()
      .refine(isCanonicalEd25519PublicKey, 'must be a Base64-encoded 32-byte Ed25519 public key')
      .default(defaultLicenseSigningPublicKey),
    LICENSE_SIGNING_PRIVATE_KEY: z
      .string()
      .refine(isBase64Encoded32ByteKey, 'must be a Base64-encoded 32-byte Ed25519 private seed')
      .optional()
      .or(z.literal(''))
      .default(''),
    SMTP_HOST: z.string().trim().default(''),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z.enum(['true', 'false']).default('false'),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_FROM: z.string().trim().default(''),
    EMAIL_CODE_TTL_MINUTES: z.coerce.number().int().min(5).max(30).default(10),
    AGENT_REQUEST_CREDITS: z.coerce.number().int().min(1).max(1_000_000).default(10),
    IMAGE_REQUEST_CREDITS: z.coerce.number().int().min(1).max(1_000_000).default(100),
    VIDEO_REQUEST_CREDITS: z.coerce.number().int().min(1).max(1_000_000).default(500),
    ADMIN_API_KEY_HASH: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hex digest')
      .optional()
      .or(z.literal(''))
      .default(''),
    PROVIDER_SECRETS_ENCRYPTION_KEY: z
      .string()
      .refine(isBase64Encoded32ByteKey, 'must be a Base64-encoded 32-byte key')
      .optional()
      .or(z.literal(''))
      .default(''),
    CORS_ALLOWED_ORIGINS: z.string().default(''),
    AI_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    AI_TASK_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(1_000),
    AI_TASK_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    AI_TASK_STALE_AFTER_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(120_000),
    AI_TASK_MAX_RUNTIME_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(15 * 60_000),
    AI_TASK_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    AI_UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    AI_UPSTREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(75_000),
    WORKER_HEALTH_FILE: z.string().min(1).default('/tmp/inspiration-worker-health'),
    IMAGE_RESULT_STORE_DIR: z.string().min(1).default(join(tmpdir(), 'inspiration-image-results')),
    IMAGE_RESULT_TTL_MINUTES: z.coerce.number().int().min(30).max(10_080).default(1_440),
    IMAGE_RESULT_STORE_MAX_MB: z.coerce.number().int().min(128).max(32_768).default(4_096),
    OSS_REGION: z.string().trim().default(''),
    OSS_BUCKET: z.string().trim().default(''),
    OSS_ACCESS_KEY_ID: z.string().trim().default(''),
    OSS_ACCESS_KEY_SECRET: z.string().trim().default(''),
  })
  .superRefine((value, context) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
    if (value.NODE_ENV === 'production' && value.HOST !== '0.0.0.0') {
      context.addIssue({
        code: 'custom',
        path: ['HOST'],
        message: 'must be 0.0.0.0 in production',
      });
    }
    if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
      context.addIssue({
        code: 'custom',
        path: ['SMTP_PASSWORD'],
        message: 'must be configured together with SMTP_USER',
      });
    }
    if (value.NODE_ENV === 'production') {
      for (const key of ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'] as const) {
        if (!value[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required in production for the OSS public-access bridge',
          });
        }
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = {
  ...parsed.data,
  smtpSecure: parsed.data.SMTP_SECURE === 'true',
  corsAllowedOrigins: parsed.data.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

export type Environment = typeof env;
