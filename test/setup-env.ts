import { createPrivateKey, createPublicKey } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const testPrivateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8',
});
const testPublicKey = createPublicKey(testPrivateKey).export({
  format: 'der',
  type: 'spki',
}) as Buffer;

process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
process.env.PORT = '3000';
process.env.APP_BASE_URL = 'https://api.example.test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test?schema=public';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-different-and-at-least-32-characters';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '30d';
process.env.LICENSE_SIGNING_PUBLIC_KEY = testPublicKey.subarray(-32).toString('base64');
process.env.LICENSE_SIGNING_PRIVATE_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PROVIDER_SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.CORS_ALLOWED_ORIGINS = 'https://www.unmind.art';
