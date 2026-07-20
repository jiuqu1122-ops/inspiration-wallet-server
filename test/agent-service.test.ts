import { describe, expect, it } from 'vitest';
import {
  buildAgentModelCandidates,
  isAgentProtocolFallbackStatus,
  isAgentProviderFallbackStatus,
  isAgentProviderRetryStatus,
  isDefaultAgentModelSentinel,
  isLikelyAgentTextModel,
  resolveConfiguredAgentModel,
  sanitizeAgentUpstreamDetail,
} from '../src/modules/ai/service.js';

describe('Agent provider fallback policy', () => {
  it('uses the configured channel model for default model sentinels', () => {
    expect(isDefaultAgentModelSentinel(undefined)).toBe(true);
    expect(isDefaultAgentModelSentinel('unmind-agent')).toBe(true);
    expect(isDefaultAgentModelSentinel('recommended')).toBe(true);
    expect(isDefaultAgentModelSentinel('gpt-5.6-sol')).toBe(false);
  });

  it('keeps the selected model on the primary channel and uses fallback channel defaults', () => {
    const primary = { defaultModel: 'primary-default' };
    const fallback = { defaultModel: 'fallback-default' };

    expect(resolveConfiguredAgentModel(primary, 'selected-model')).toBe('selected-model');
    expect(resolveConfiguredAgentModel(fallback, 'selected-model', true)).toBe('fallback-default');
    expect(resolveConfiguredAgentModel({ defaultModel: null }, 'selected-model', true)).toBe('selected-model');
  });

  it('falls back for gateway failures and protocol-specific channel errors', () => {
    expect(isAgentProviderFallbackStatus(524)).toBe(true);
    expect(isAgentProviderFallbackStatus(502)).toBe(true);
    expect(isAgentProviderFallbackStatus(429)).toBe(true);
    expect(isAgentProtocolFallbackStatus(404)).toBe(true);
    expect(isAgentProviderFallbackStatus(409)).toBe(false);
  });

  it('retries transient gateway errors without retrying protocol failures', () => {
    expect(isAgentProviderRetryStatus(504)).toBe(true);
    expect(isAgentProviderRetryStatus(524)).toBe(true);
    expect(isAgentProviderRetryStatus(503)).toBe(true);
    expect(isAgentProviderRetryStatus(429)).toBe(false);
    expect(isAgentProviderRetryStatus(400)).toBe(false);
  });

  it('selects another text model from the same channel after a model failure', () => {
    expect(buildAgentModelCandidates(
      { defaultModel: 'claude-sonnet-4-5' },
      'gemini-2.5-pro',
      [
        'gemini-3-pro-image-preview',
        'text-embedding-3-large',
        'gemini-2.5-flash',
        'claude-sonnet-4-5',
      ],
    )).toEqual([
      'gemini-2.5-pro',
      'claude-sonnet-4-5',
      'gemini-2.5-flash',
    ]);
  });

  it('filters non-Agent models discovered on a mixed-capability channel', () => {
    expect(isLikelyAgentTextModel('gpt-5.4')).toBe(true);
    expect(isLikelyAgentTextModel('qwen3-vl-plus')).toBe(true);
    expect(isLikelyAgentTextModel('gpt-image-2')).toBe(false);
    expect(isLikelyAgentTextModel('Xais Nano Pro_2K')).toBe(false);
    expect(isLikelyAgentTextModel('seedance-1.5-pro')).toBe(false);
    expect(isLikelyAgentTextModel('text-embedding-3-large')).toBe(false);
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
