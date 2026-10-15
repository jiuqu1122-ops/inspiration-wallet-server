import { describe, expect, it } from 'vitest';
import { aiMediaMidjourneyPrompt, aiMediaMidjourneyRequestHeaders } from '../src/modules/ai/ai-media-midjourney-request.js';

const provider = { id: 'channel-a', baseUrl: 'https://api.ai-media.vip' };
const input = { userId: 'owner-a', clientRequestId: 'new-request-a' };
const route = { adapterKey: 'GENERIC_OPENAI_IMAGE', canonicalModelKey: 'midjourney-v7', upstreamModel: 'Midjourney V7（满血）' };
const prompt = 'Original user instructions.\n\nStrict image constraints: must output exactly 16:9 aspect ratio.';

describe('the confirmed ai-media Midjourney request cache', () => {
  it('uses a stable uint32 seed and receipt hash, isolated by user, channel and client request', () => {
    const original = JSON.stringify([provider, input, route]);
    const first = aiMediaMidjourneyPrompt(prompt, provider, input, route);
    const seed = Number(first.match(/--seed (\d+)$/)![1]);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(4294967295);
    expect(first).toBe(`${prompt}\n\n--seed ${seed}`);
    expect(aiMediaMidjourneyPrompt(prompt, provider, input, route)).toBe(first);
    const headers = aiMediaMidjourneyRequestHeaders(provider, input, route)!;
    expect(headers['Idempotency-Key']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers['X-Request-Id']).toBe(headers['Idempotency-Key']);
    expect(headers['Cache-Control']).toBe('no-cache, no-store');
    expect(headers.Pragma).toBe('no-cache');
    expect(aiMediaMidjourneyRequestHeaders(provider, input, route)).toEqual(headers);
    for (const [channel, identity] of [
      [provider, { ...input, clientRequestId: 'new-request-b' }],
      [provider, { ...input, userId: 'owner-b' }],
      [{ ...provider, id: 'channel-b' }, input],
    ] as const) {
      expect(aiMediaMidjourneyPrompt(prompt, channel, identity, route)).not.toBe(first);
      expect(aiMediaMidjourneyRequestHeaders(channel, identity, route)).not.toEqual(headers);
    }
    expect(JSON.stringify([provider, input, route])).toBe(original);
  });

  it.each(['--seed 0', '--seed 4294967295', '--SEED 123', '--seed=42'])('preserves the explicit user setting %s', seed => {
    const explicit = `Original user instructions ${seed}.\n\nStrict image constraints: preserve the composition.`;
    expect(aiMediaMidjourneyPrompt(explicit, provider, input, route)).toBe(explicit);
    expect(aiMediaMidjourneyPrompt(explicit, provider, { ...input, clientRequestId: 'another-receipt' }, route)).toBe(explicit);
  });

  it('applies to an explicitly named future Midjourney version without hardcoding V7', () => {
    expect(aiMediaMidjourneyPrompt(prompt, provider, input, { ...route,
      canonicalModelKey: 'midjourney-v8.2', upstreamModel: 'Midjourney V8.2' })).toMatch(/--seed \d+$/);
  });

  it('recognizes a hyphenated canonical Midjourney model even when its upstream name is an opaque alias', () => {
    expect(aiMediaMidjourneyPrompt(prompt, provider, input, { ...route,
      canonicalModelKey: 'midjourney-v7', upstreamModel: 'MJ-v7-upstream-alias' })).toMatch(/--seed \d+$/);
  });

  it.each([
    [{ ...provider, baseUrl: 'https://other-provider.example' }, route],
    [{ ...provider, baseUrl: 'https://www.api.ai-media.vip' }, route],
    [{ ...provider, baseUrl: 'https://api.ai-media.vip.other.example' }, route],
    [{ ...provider, baseUrl: 'invalid-url' }, route],
    [provider, { ...route, adapterKey: 'GPT_IMAGE' }],
    [provider, { ...route, adapterKey: 'SEEDREAM_IMAGES_API' }],
    [provider, { ...route, canonicalModelKey: 'gpt-image-2', upstreamModel: 'gpt-image-2' }],
    [provider, { ...route, canonicalModelKey: 'seedream-4.5', upstreamModel: 'seedream-4.5' }],
    [provider, { ...route, canonicalModelKey: 'not-midjourney-v7', upstreamModel: 'vendor-other' }],
    [provider, { ...route, canonicalModelKey: 'midjourneyish', upstreamModel: 'midjourneyish-v7' }],
    [provider, undefined],
  ])('does not alter any unrelated provider, adapter or model contract: %j / %j', (channel, adapterRoute) => {
    expect(aiMediaMidjourneyPrompt(prompt, channel, input, adapterRoute)).toBe(prompt);
    expect(aiMediaMidjourneyRequestHeaders(channel, input, adapterRoute)).toBeUndefined();
  });
});
