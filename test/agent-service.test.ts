import { describe, expect, it } from 'vitest';
import {
  isAgentProtocolFallbackStatus,
  isAgentProviderFallbackStatus,
  isDefaultAgentModelSentinel,
  sanitizeAgentUpstreamDetail,
} from '../src/modules/ai/service.js';

describe('Agent provider fallback policy', () => {
  it('uses the configured channel model for default model sentinels', () => {
    expect(isDefaultAgentModelSentinel(undefined)).toBe(true);
    expect(isDefaultAgentModelSentinel('unmind-agent')).toBe(true);
    expect(isDefaultAgentModelSentinel('recommended')).toBe(true);
    expect(isDefaultAgentModelSentinel('gpt-5.6-sol')).toBe(false);
  });

  it('falls back for gateway failures and protocol-specific channel errors', () => {
    expect(isAgentProviderFallbackStatus(524)).toBe(true);
    expect(isAgentProviderFallbackStatus(502)).toBe(true);
    expect(isAgentProviderFallbackStatus(429)).toBe(true);
    expect(isAgentProtocolFallbackStatus(404)).toBe(true);
    expect(isAgentProviderFallbackStatus(409)).toBe(false);
  });

  it('redacts credentials from upstream error details', () => {
    const detail = sanitizeAgentUpstreamDetail(
      'authorization=sk-secretvalue123456 token=eyJabc.def.ghi request timed out',
    );
    expect(detail).not.toContain('secretvalue');
    expect(detail).not.toContain('eyJabc');
    expect(detail).toContain('[REDACTED]');
  });
});
