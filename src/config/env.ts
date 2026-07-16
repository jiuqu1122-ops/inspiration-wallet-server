import { z } from 'zod';

const defaultLicenseSigningPublicKey = 'AAS4rzI5dxFefYmQCNp1wYpYgKwMXp5+wG1WgF/UoRQ=';

function isCanonicalEd25519PublicKey(value: string) {
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
    CORS_ALLOWED_ORIGINS: z.string().default(''),
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
  corsAllowedOrigins: parsed.data.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

export type Environment = typeof env;
