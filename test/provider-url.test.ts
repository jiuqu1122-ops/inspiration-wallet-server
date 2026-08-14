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

  it('keeps the Mikoto base URL at the channel root', () => {
    expect(normalizeProviderBaseUrl('MIKOTO', 'https://api.mikoto.vip/v1/models'))
      .toBe('https://api.mikoto.vip');
    expect(normalizeProviderBaseUrl('MIKOTO', 'https://api.mikoto.vip/v1/videos'))
      .toBe('https://api.mikoto.vip');
  });

  it('normalizes the configured USELG /v1 URL to the channel root', () => {
    expect(normalizeProviderBaseUrl('USELG', 'https://api.ai-media.vip/v1'))
      .toBe('https://api.ai-media.vip');
  });

  it('normalizes a Bigmodel native Gemini endpoint to the channel root', () => {
    expect(normalizeProviderBaseUrl('BIGMODEL', 'https://st.smart-agi.com/v1beta/models/gemini-3-pro-image-preview:generateContent'))
      .toBe('https://st.smart-agi.com');
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
