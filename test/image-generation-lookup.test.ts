import { describe, expect, it, vi } from 'vitest';
import { getWalletImageGenerationByRequest } from '../src/modules/ai/image-service.js';
import { buildFailureDiagnostic } from '../src/modules/ai/failure-diagnostic.js';

describe('image request failure lookup', () => {
  it.each(['FAILED', 'REFUNDED'])('returns a safe failure to the client for %s', async status => {
    const diagnostic = buildFailureDiagnostic(new Error('upstream error: 400 message=Image URL is blocked https://private.example/prompt-secret.png'), { stage: 'image_generation' });
    const findUnique = vi.fn().mockResolvedValue({ capability: 'IMAGE', status,
      result: null, completedAt: new Date(), failureDiagnostic: { ...diagnostic, message: 'malicious stored URL https://private.example/secret' } });
    const result = await getWalletImageGenerationByRequest({ aiRequest: { findUnique } } as never, 'fixture-user', 'fixture-image-request');
    expect(result).toMatchObject({ status: status.toLowerCase(), error: { code: 'PROVIDER_IMAGE_URL_BLOCKED', httpStatus: 400 } });
    expect(JSON.stringify(result)).not.toContain('private.example');
    expect(JSON.stringify(result)).not.toContain('prompt-secret');
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ failureDiagnostic: true }) }));
  });

  it('does not invent a failure for processing or recovery-required requests', async () => {
    const diagnostic = buildFailureDiagnostic(new Error('HTTP 400'), { stage: 'image_generation' });
    const findUnique = vi.fn().mockResolvedValue({ capability: 'IMAGE', status: 'PROCESSING',
      result: { recovery: {} }, completedAt: null, failureDiagnostic: diagnostic });
    const result = await getWalletImageGenerationByRequest({ aiRequest: { findUnique } } as never, 'fixture-user', 'fixture-image-request');
    expect(result).toMatchObject({ status: 'processing', confirmationRequired: true, recoveryStatus: 'manual_confirmation_required' });
    expect(result).not.toHaveProperty('error');
  });

  it('rejects unknown stored failure codes instead of returning untrusted content', async () => {
    const findUnique = vi.fn().mockResolvedValue({ capability: 'IMAGE', status: 'FAILED',
      result: null, completedAt: null, failureDiagnostic: { version: 1, code: 'untrusted', message: 'secret' } });
    const result = await getWalletImageGenerationByRequest({ aiRequest: { findUnique } } as never, 'fixture-user', 'fixture-image-request');
    expect(result).not.toHaveProperty('error');
  });
});
