import { describe, expect, it } from 'vitest';
import {
  decryptProviderSecrets,
  encryptProviderSecrets,
} from '../src/lib/provider-secrets.js';

describe('provider secret encryption', () => {
  const key = Buffer.alloc(32, 4).toString('base64');

  it('round-trips API keys and custom headers without plaintext leakage', () => {
    const secrets = {
      apiKey: 'sk-upstream-super-secret',
      headers: { 'X-Linggan-NewAPI-Access-Token': 'xais-management-secret-value' },
    };
    const encoded = encryptProviderSecrets(secrets, key);
    expect(encoded).not.toContain(secrets.apiKey);
    expect(encoded).not.toContain('xais-management-secret-value');
    expect(decryptProviderSecrets(encoded, key)).toEqual(secrets);
  });

  it('rejects decryption with a different master key', () => {
    const encoded = encryptProviderSecrets({ apiKey: 'sk-secret', headers: {} }, key);
    const wrongKey = Buffer.alloc(32, 5).toString('base64');
    expect(() => decryptProviderSecrets(encoded, wrongKey)).toThrow();
  });
});
