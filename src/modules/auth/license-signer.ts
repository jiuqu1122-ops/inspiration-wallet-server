import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../../config/env.js';

const productName = 'Inspiration Drawer';
const ed25519Pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');

type ServerLicenseInput = {
  licenseId: string;
  customer: string;
  machineId: string;
  edition: 'trial' | 'pro' | 'enterprise';
  features: string[];
  expiresAt: Date;
};

function signingKey() {
  if (!env.LICENSE_SIGNING_PRIVATE_KEY) {
    throw new Error('Automatic license signing is not configured');
  }

  const privateSeed = Buffer.from(env.LICENSE_SIGNING_PRIVATE_KEY, 'base64');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ed25519Pkcs8Prefix, privateSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const configuredPublicKey = Buffer.from(env.LICENSE_SIGNING_PUBLIC_KEY, 'base64');
  const derivedPublicKey = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  }) as Buffer;
  const derivedRawPublicKey = derivedPublicKey.subarray(-32);
  if (
    configuredPublicKey.length !== derivedRawPublicKey.length
    || !timingSafeEqual(configuredPublicKey, derivedRawPublicKey)
  ) {
    throw new Error('License signing private key does not match the configured public key');
  }
  return privateKey;
}

export function canSignServerLicenses() {
  return Boolean(env.LICENSE_SIGNING_PRIVATE_KEY);
}

export function signServerLicense(input: ServerLicenseInput) {
  const payload = {
    license_id: input.licenseId,
    product: productName,
    customer: input.customer,
    machine_id: input.machineId.trim().toLowerCase(),
    edition: input.edition,
    features: input.features,
    expire_at: input.expiresAt.toISOString().slice(0, 10),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = signBytes(null, payloadBytes, signingKey());

  return JSON.stringify({
    payload: payloadBytes.toString('base64'),
    signature: signature.toString('base64'),
  });
}
