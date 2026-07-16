import { createPrivateKey, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  LicenseVerificationError,
  verifySignedLicense,
} from '../src/modules/auth/license-verifier.js';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8',
});
const machineId = 'a'.repeat(64);

type LicensePayload = {
  license_id?: string;
  product: string;
  customer: string;
  machine_id: string;
  edition: string;
  features: string[];
  expire_at: string;
  ai_access?: {
    api_key: string;
    base_url: string;
  };
};

const validPayload = (): LicensePayload => ({
  product: 'Inspiration Drawer',
  customer: 'private-customer@example.test',
  machine_id: machineId,
  edition: 'pro',
  features: ['canvas', 'ai', 'canvas'],
  expire_at: '2099-12-31',
  ai_access: {
    api_key: 'must-never-leave-the-license-verifier',
    base_url: 'https://upstream.example.test',
  },
});

const signPayload = (payload: LicensePayload) => {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');

  return JSON.stringify({
    payload: payloadBytes.toString('base64'),
    signature: sign(null, payloadBytes, privateKey).toString('base64'),
  });
};

const expectLicenseError = (action: () => unknown, code: string) => {
  try {
    action();
    throw new Error(`Expected LicenseVerificationError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(LicenseVerificationError);
    expect((error as LicenseVerificationError).code).toBe(code);
  }
};

describe('verifyLicense', () => {
  it('verifies a signed license and only returns safe identity claims', () => {
    const result = verifySignedLicense(signPayload(validPayload()), machineId);

    expect(result).toEqual({
      codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      machineIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      edition: 'PRO',
      features: ['canvas', 'ai'],
      expiresAt: new Date('2099-12-31T23:59:59.999Z'),
    });
    expect(result).not.toHaveProperty('customer');
    expect(result).not.toHaveProperty('ai_access');
  });

  it('rejects payload tampering after signing', () => {
    const signed = JSON.parse(signPayload(validPayload())) as {
      payload: string;
      signature: string;
    };
    const tampered = {
      ...validPayload(),
      edition: 'enterprise',
    };
    signed.payload = Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64');

    expectLicenseError(() => verifySignedLicense(JSON.stringify(signed), machineId), 'invalid_signature');
  });

  it('rejects a license bound to a different machine', () => {
    expectLicenseError(
      () => verifySignedLicense(signPayload(validPayload()), 'b'.repeat(64)),
      'machine_mismatch',
    );
  });

  it('rejects an expired license', () => {
    expectLicenseError(
      () => verifySignedLicense(signPayload({ ...validPayload(), expire_at: '2000-01-01' }), machineId),
      'expired',
    );
  });

  it('rejects malformed outer license data', () => {
    expectLicenseError(
      () => verifySignedLicense('{"payload":"not-base64"}', machineId),
      'malformed_license',
    );
  });

  it('keeps a server-issued license identity stable when the expiration changes', () => {
    const original = {
      ...validPayload(),
      license_id: `trial_${'f'.repeat(64)}`,
    };
    const renewed = { ...original, expire_at: '2100-12-31' };

    const first = verifySignedLicense(signPayload(original), machineId);
    const second = verifySignedLicense(signPayload(renewed), machineId);

    expect(first.codeHash).toBe(second.codeHash);
  });
});
