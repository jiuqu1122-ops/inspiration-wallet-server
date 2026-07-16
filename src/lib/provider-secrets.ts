import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const algorithm = 'aes-256-gcm';
const version = 'v1';
const aad = Buffer.from('inspiration-wallet-provider-secrets:v1', 'utf8');

export type ProviderSecrets = {
  apiKey: string;
  headers: Record<string, string>;
};

export class ProviderSecretsConfigurationError extends Error {
  constructor() {
    super('Provider credential encryption is not configured');
    this.name = 'ProviderSecretsConfigurationError';
  }
}

function encryptionKey(value = env.PROVIDER_SECRETS_ENCRYPTION_KEY) {
  if (!value) throw new ProviderSecretsConfigurationError();
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new ProviderSecretsConfigurationError();
  return key;
}

export function encryptProviderSecrets(
  secrets: ProviderSecrets,
  keyValue?: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, encryptionKey(keyValue), iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptProviderSecrets(
  encoded: string,
  keyValue?: string,
): ProviderSecrets {
  const [encodedVersion, ivValue, tagValue, ciphertextValue, extra] = encoded.split('.');
  if (
    encodedVersion !== version || !ivValue || !tagValue || !ciphertextValue || extra !== undefined
  ) {
    throw new Error('Unsupported encrypted provider credential format');
  }
  const decipher = createDecipheriv(
    algorithm,
    encryptionKey(keyValue),
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]);
  const parsed = JSON.parse(plaintext.toString('utf8')) as Partial<ProviderSecrets>;
  if (typeof parsed.apiKey !== 'string' || !parsed.headers || typeof parsed.headers !== 'object') {
    throw new Error('Encrypted provider credential payload is invalid');
  }
  const headers = Object.fromEntries(
    Object.entries(parsed.headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  return { apiKey: parsed.apiKey, headers };
}
