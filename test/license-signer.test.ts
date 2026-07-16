import { describe, expect, it } from 'vitest';
import { signServerLicense } from '../src/modules/auth/license-signer.js';
import { verifySignedLicenseForProvision } from '../src/modules/auth/license-verifier.js';

describe('signServerLicense', () => {
  it('creates a machine-bound license that the production verifier accepts', () => {
    const machineId = 'c'.repeat(64);
    const licenseId = `trial_${'d'.repeat(64)}`;
    const license = signServerLicense({
      licenseId,
      customer: '测试用户',
      machineId,
      edition: 'trial',
      features: ['*'],
      expiresAt: new Date('2099-01-30T23:59:59.999Z'),
    });

    const verified = verifySignedLicenseForProvision(license, machineId);
    expect(verified.customer).toBe('测试用户');
    expect(verified.edition).toBe('TRIAL');
    expect(verified.features).toEqual(['*']);
    expect(verified.codeHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
