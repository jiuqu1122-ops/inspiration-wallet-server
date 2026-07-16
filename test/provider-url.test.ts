import { describe, expect, it } from 'vitest';
import { isPublicIp, normalizeProviderBaseUrl, providerEndpoint } from '../src/modules/providers/url.js';

describe('provider URL safety and normalization', () => {
  it('normalizes NewAPI and XAIS endpoints using the main application rules', () => {
    expect(normalizeProviderBaseUrl('NEW_API', 'https://gateway.example.com/tenant/v1/models'))
      .toBe('https://gateway.example.com/tenant');
    expect(normalizeProviderBaseUrl('XAIS', 'https://xais.example.com/xais/userProfile'))
      .toBe('https://xais.example.com');
    expect(providerEndpoint('https://gateway.example.com/tenant', '/v1/models'))
      .toBe('https://gateway.example.com/tenant/v1/models');
  });

  it('rejects unsafe schemes, credentials, and local hosts', () => {
    expect(() => normalizeProviderBaseUrl('NEW_API', 'http://gateway.example.com'))
      .toThrow('HTTPS');
    expect(normalizeProviderBaseUrl('NEW_API', 'http://38.145.218.40:12001/v1', true))
      .toBe('http://38.145.218.40:12001');
    expect(() => normalizeProviderBaseUrl('NEW_API', 'https://user:pass@gateway.example.com'))
      .toThrow('credentials');
    expect(() => normalizeProviderBaseUrl('XAIS', 'https://127.0.0.1'))
      .toThrow('public host');
  });

  it('classifies private and documentation addresses as non-public', () => {
    expect(isPublicIp('10.0.0.1')).toBe(false);
    expect(isPublicIp('169.254.169.254')).toBe(false);
    expect(isPublicIp('192.0.2.10')).toBe(false);
    expect(isPublicIp('2001:db8::1')).toBe(false);
    expect(isPublicIp('1.1.1.1')).toBe(true);
  });
});
