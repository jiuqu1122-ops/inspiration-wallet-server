import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';

const productName = 'Inspiration Drawer';
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

const licenseFileSchema = z
  .object({
    payload: z.string().min(1).max(350_000),
    signature: z.string().min(1).max(512),
  })
  .strict();

const licensePayloadSchema = z.object({
  product: z.string().min(1).max(128),
  customer: z.string().min(1).max(512),
  machine_id: z.string().regex(/^[a-fA-F0-9]{64}$/),
  edition: z.enum(['trial', 'pro', 'enterprise']),
  features: z.array(z.string().max(128)).max(200).default([]),
  expire_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type VerifiedLicense = {
  codeHash: string;
  machineIdHash: string;
  edition: 'TRIAL' | 'PRO' | 'ENTERPRISE';
  features: string[];
  expiresAt: Date;
};

export type VerifiedLicenseWithCustomer = VerifiedLicense & { customer: string };

export type LicenseVerificationErrorCode =
  | 'malformed_license'
  | 'invalid_signature'
  | 'machine_mismatch'
  | 'product_mismatch'
  | 'expired'
  | 'invalid_public_key';

export class LicenseVerificationError extends Error {
  constructor(
    public readonly code: LicenseVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LicenseVerificationError';
  }
}

function decodeCanonicalBase64(value: string, code: LicenseVerificationErrorCode, message: string) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new LicenseVerificationError(code, message);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new LicenseVerificationError(code, message);
  }
  return decoded;
}

function parseJson(value: string | Buffer, message: string): unknown {
  try {
    return JSON.parse(value.toString());
  } catch {
    throw new LicenseVerificationError('malformed_license', message);
  }
}

function expirationEndOfDay(value: string) {
  const date = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new LicenseVerificationError('malformed_license', 'License expiration date is invalid');
  }
  return date;
}

function normalizeFeatures(features: string[]) {
  const normalized = [...new Set(features.map((feature) => feature.trim().toLowerCase()).filter(Boolean))];
  return normalized.includes('*') ? ['*'] : normalized;
}

export function hashRefreshToken(token: string) {
  return createHash('sha256').update('inspiration-wallet-refresh-v1\0').update(token).digest('hex');
}

function verifySignedLicenseDocument(
  content: string,
  submittedMachineId?: string,
): VerifiedLicenseWithCustomer {
  const fileResult = licenseFileSchema.safeParse(parseJson(content, 'License file is not valid JSON'));
  if (!fileResult.success) {
    throw new LicenseVerificationError('malformed_license', 'License file format is invalid');
  }

  const payloadBytes = decodeCanonicalBase64(
    fileResult.data.payload,
    'malformed_license',
    'License payload is not valid Base64',
  );
  const signatureBytes = decodeCanonicalBase64(
    fileResult.data.signature,
    'invalid_signature',
    'License signature is invalid',
  );
  if (signatureBytes.length !== 64) {
    throw new LicenseVerificationError('invalid_signature', 'License signature is invalid');
  }

  const publicKeyBytes = decodeCanonicalBase64(
    env.LICENSE_SIGNING_PUBLIC_KEY,
    'invalid_public_key',
    'License public key is invalid',
  );
  if (publicKeyBytes.length !== 32) {
    throw new LicenseVerificationError('invalid_public_key', 'License public key is invalid');
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ed25519SpkiPrefix, publicKeyBytes]),
      format: 'der',
      type: 'spki',
    });
    if (!verify(null, payloadBytes, publicKey, signatureBytes)) {
      throw new LicenseVerificationError('invalid_signature', 'License signature is invalid');
    }
  } catch (error) {
    if (error instanceof LicenseVerificationError) {
      throw error;
    }
    throw new LicenseVerificationError('invalid_public_key', 'License public key is invalid');
  }

  const payloadResult = licensePayloadSchema.safeParse(
    parseJson(payloadBytes, 'License payload is not valid JSON'),
  );
  if (!payloadResult.success) {
    throw new LicenseVerificationError('malformed_license', 'License payload format is invalid');
  }
  const payload = payloadResult.data;

  if (payload.product.trim() !== productName) {
    throw new LicenseVerificationError('product_mismatch', 'License product does not match');
  }
  const machineId = payload.machine_id.trim().toLowerCase();
  const claimedMachineId = submittedMachineId?.trim().toLowerCase();
  if (claimedMachineId !== undefined && claimedMachineId !== machineId) {
    throw new LicenseVerificationError('machine_mismatch', 'License machine ID does not match');
  }

  const expiresAt = expirationEndOfDay(payload.expire_at.trim());
  const today = new Date().toISOString().slice(0, 10);
  if (payload.expire_at < today) {
    throw new LicenseVerificationError('expired', 'License has expired');
  }

  const codeHash = createHash('sha256')
    .update('inspiration-drawer-license-v1\0')
    .update(payloadBytes)
    .update('\0')
    .update(signatureBytes)
    .digest('hex');
  const machineIdHash = createHash('sha256')
    .update('inspiration-drawer-machine-v1\0')
    .update(machineId)
    .digest('hex');

  return {
    codeHash,
    customer: payload.customer.trim(),
    machineIdHash,
    edition: payload.edition.toUpperCase() as VerifiedLicense['edition'],
    features: normalizeFeatures(payload.features),
    expiresAt,
  };
}

export function verifySignedLicense(content: string, submittedMachineId?: string): VerifiedLicense {
  const verified = verifySignedLicenseDocument(
    content,
    submittedMachineId,
  );
  return {
    codeHash: verified.codeHash,
    machineIdHash: verified.machineIdHash,
    edition: verified.edition,
    features: verified.features,
    expiresAt: verified.expiresAt,
  };
}

export function verifySignedLicenseForProvision(
  content: string,
  submittedMachineId?: string,
): VerifiedLicenseWithCustomer {
  return verifySignedLicenseDocument(content, submittedMachineId);
}
