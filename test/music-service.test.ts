import { describe, expect, it, vi } from 'vitest';
import { parseMusicResponse, submitMusic, MusicUpstreamError } from '../src/modules/ai/music-adapter.js';
import { calculateSnapshotCharge, type PricingSnapshot } from '../src/modules/ai/pricing-center.js';

describe('music adapter and request billing', () => {
  it('extracts and deduplicates audio from all choices including structured content', () => {
    const result = parseMusicResponse({ choices: [{ message: { content: '[Listen](https://cdn.example.com/a.mp3) https://cdn.example.com/b.wav?token=test' } }, { message: { content: JSON.stringify({ audio_url: 'https://cdn.example.com/a.mp3' }) } }] });
    expect(result).toEqual({ type: 'audio', content: '', audioUrls: ['https://cdn.example.com/a.mp3', 'https://cdn.example.com/b.wav?token=test'], assets: [{ assetType: 'audio', url: 'https://cdn.example.com/a.mp3' }, { assetType: 'audio', url: 'https://cdn.example.com/b.wav?token=test' }] });
  });
  it('submits the configured upstream model once using the music protocol', async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'https://cdn.example.com/song.mp3' } }] }), { status: 200 }));
    await submitMusic('https://provider.example.com/v1', { apiKey: 'test', headers: {} }, 'configured-audio-model', 'ambient music', send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls[0][1]?.body))).toEqual({ model: 'configured-audio-model', messages: [{ role: 'user', content: 'ambient music' }], n: 1, stream: false });
  });
  it.each([500, 503, 408])('never repeats a POST after HTTP %s', async status => {
    const send = vi.fn(async () => new Response('', { status }));
    await expect(submitMusic('https://provider.example.com', { apiKey: 'test', headers: {} }, 'audio', 'music', send)).rejects.toMatchObject({ uncertain: true });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('never repeats a POST after connection failure or timeout', async () => {
    const send = vi.fn(async () => { throw new Error('timeout'); });
    await expect(submitMusic('https://provider.example.com', { apiKey: 'test', headers: {} }, 'audio', 'music', send)).rejects.toBeInstanceOf(MusicUpstreamError);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('bills music once irrespective of quantity, duration or tokens', () => {
    const snapshot: PricingSnapshot = { schemaVersion: 1, canonicalModelId: 'music', canonicalModelKey: 'configured-music', modality: 'audio', routeId: 'route', priceVersionId: 'price', priceVersion: 1, billingType: 'music_flat', pricing: { billingType: 'music_flat', creditsPerRequest: '12.5' }, request: { count: 4, duration: 999, tokens: 100000 }, capturedAt: '' };
    expect(calculateSnapshotCharge(snapshot, { generatedCount: 8 })).toMatchObject({ quantity: '1', totalCredits: '12.500000' });
  });
});
