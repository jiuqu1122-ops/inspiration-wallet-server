import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { MusicUpstreamError } from '../src/modules/ai/music-adapter.js';
const audioStore = vi.hoisted(() => ({
  assertAudioResultStorageConfigured: vi.fn(),
  createAudioStorageToken: vi.fn(() => 'a'.repeat(64)),
  mirrorGeneratedAudioResultToStorage: vi.fn(async (source: string) => ({ assetType: 'audio', url: `https://api.example.test/v1/ai/audio-results/${source.split('/').pop()}`, objectKey: `generated-audios/${source.split('/').pop()}`, mime: 'audio/mpeg', size: 100, name: 'music.mp3' })),
}));
vi.mock('../src/modules/ai/audio-result-store.js', () => audioStore);

vi.mock('../src/modules/ai/model-catalog.js', async importOriginal => ({ ...await importOriginal<object>(), resolveCatalogModel: vi.fn(async () => ({ model: { id: 'music-model', canonicalModelKey: 'configured-audio', modality: 'audio', billingType: 'music_flat' }, route: { id: 'route', upstreamModelId: 'provider-audio', channel: { baseUrl: 'https://provider.example.com', encryptedSecrets: 'encrypted' } } })) }));
vi.mock('../src/modules/ai/pricing-center.js', async importOriginal => ({ ...await importOriginal<object>(), capturePricingSnapshot: vi.fn(async () => ({ schemaVersion: 1, canonicalModelId: 'music-model', canonicalModelKey: 'configured-audio', modality: 'audio', routeId: 'route', priceVersionId: 'price', priceVersion: 1, billingType: 'music_flat', pricing: { billingType: 'music_flat', creditsPerRequest: '12' }, request: {}, capturedAt: '' })) }));
vi.mock('../src/lib/provider-secrets.js', () => ({ decryptProviderSecrets: () => ({ apiKey: 'test', headers: {} }) }));
vi.mock('../src/modules/providers/url.js', () => ({ assertPublicProviderUrl: vi.fn(async () => {}) }));
import { executeWalletMusicGeneration, getWalletMusicGenerationByRequest } from '../src/modules/ai/music-service.js';
import { capturePricingSnapshot } from '../src/modules/ai/pricing-center.js';

describe('music wallet idempotency', () => {
  let request: any;
  let available: Prisma.Decimal;
  let reserved: Prisma.Decimal;
  let tx: any;
  let prisma: any;
  beforeEach(() => {
    vi.clearAllMocks();
    request = null; available = new Prisma.Decimal(100); reserved = new Prisma.Decimal(0);
    tx = {
      aiRequest: {
        findUnique: vi.fn(async () => request),
        create: vi.fn(async ({ data }: any) => { request = { id: 'request', ...data }; return request; }),
        updateMany: vi.fn(async ({ where, data }: any) => { if (request.status !== where.status) return { count: 0 }; Object.assign(request, data); return { count: 1 }; }),
      },
      wallet: {
        updateMany: vi.fn(async () => { available = available.minus(12); reserved = reserved.plus(12); return { count: 1 }; }),
        update: vi.fn(async ({ data }: any) => { reserved = reserved.minus(data.reservedCredits.decrement); if (data.availableCredits?.increment) available = available.plus(data.availableCredits.increment); }),
        findUniqueOrThrow: vi.fn(async () => ({ availableCredits: available, reservedCredits: reserved })),
      },
      walletLedger: { create: vi.fn(async () => ({})) }, aiBillingSettlement: { create: vi.fn(async () => ({})) },
    };
    prisma = { $transaction: async (fn: (client: any) => unknown) => fn(tx) };
  });
  const input = { userId: 'user', clientRequestId: 'music-request', model: 'configured-audio', prompt: 'Music' };
  it('persists all audio assets and charges once when the client repeats a completed request', async () => {
    const submit = vi.fn(async () => ({ type: 'audio' as const, content: '', audioUrls: ['https://cdn.example.com/a.mp3', 'https://cdn.example.com/b.mp3'], assets: [{ assetType: 'audio' as const, url: 'https://cdn.example.com/a.mp3' }, { assetType: 'audio' as const, url: 'https://cdn.example.com/b.mp3' }] }));
    const first = await executeWalletMusicGeneration(prisma, input, submit);
    expect(await executeWalletMusicGeneration(prisma, input, submit)).toEqual(first);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(request.result.audioUrls).toHaveLength(2);
    expect(request.result.audioUrls).toEqual(['https://api.example.test/v1/ai/audio-results/a.mp3', 'https://api.example.test/v1/ai/audio-results/b.mp3']);
    expect(request.result.assets[0]).toMatchObject({ assetType: 'audio', objectKey: 'generated-audios/a.mp3', name: '音乐 1.mp3' });
    expect(JSON.stringify(request.result)).not.toContain('cdn.example.com');
    expect(tx.walletLedger.create.mock.calls.map(([entry]: any) => entry.data.type)).toEqual(['RESERVE', 'CHARGE']);
    expect(tx.aiBillingSettlement.create).toHaveBeenCalledTimes(1);
    expect(available.toString()).toBe('88'); expect(reserved.toString()).toBe('0');
  });
  it('recovers a partial COS failure using the saved receipt and original pricing without another music POST', async () => {
    const submit = vi.fn(async () => ({ type: 'audio' as const, content: '', audioUrls: ['https://cdn.example.com/a.mp3', 'https://cdn.example.com/b.mp3'], assets: [] }));
    audioStore.mirrorGeneratedAudioResultToStorage.mockImplementationOnce(async () => ({ assetType: 'audio', url: 'https://api.example.test/v1/ai/audio-results/a.mp3', objectKey: 'generated-audios/a.mp3', mime: 'audio/mpeg', size: 100, name: 'music.mp3' }));
    audioStore.mirrorGeneratedAudioResultToStorage.mockRejectedValueOnce(new Error('COS unavailable'));
    await expect(executeWalletMusicGeneration(prisma, input, submit)).rejects.toMatchObject({ code: 'music_storage_pending' });
    expect(request.result.kind).toBe('music_storage_pending');
    expect(request.result.tracks[0].asset).toBeDefined();
    expect(request.status).toBe('PROCESSING');
    expect(reserved.toString()).toBe('12');
    const recovered = await getWalletMusicGenerationByRequest(prisma, 'user', 'music-request');
    expect(recovered).toMatchObject({ chargedCredits: '12.000000', audioUrls: expect.arrayContaining(['https://api.example.test/v1/ai/audio-results/a.mp3']) });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(capturePricingSnapshot).toHaveBeenCalledTimes(1);
    expect(audioStore.mirrorGeneratedAudioResultToStorage).toHaveBeenCalledTimes(3);
    expect(tx.aiBillingSettlement.create).toHaveBeenCalledTimes(1);
    expect(reserved.toString()).toBe('0');
    expect(await executeWalletMusicGeneration(prisma, input, submit)).toEqual(recovered);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('fails before submitting or reserving credits when object storage is unconfigured', async () => {
    audioStore.assertAudioResultStorageConfigured.mockImplementationOnce(() => { throw new Error('missing storage'); });
    const submit = vi.fn();
    await expect(executeWalletMusicGeneration(prisma, input, submit)).rejects.toMatchObject({ code: 'audio_storage_unavailable' });
    expect(submit).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(available.toString()).toBe('100');
  });
  it('keeps an uncertain submission reserved and rejects a repeated POST without contacting upstream', async () => {
    const submit = vi.fn(async () => { throw new MusicUpstreamError(503, true); });
    await expect(executeWalletMusicGeneration(prisma, input, submit)).rejects.toMatchObject({ code: 'music_submission_uncertain' });
    await expect(executeWalletMusicGeneration(prisma, input, submit)).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(request.status).toBe('PROCESSING');
    expect(tx.walletLedger.create.mock.calls.map(([entry]: any) => entry.data.type)).toEqual(['RESERVE']);
  });
  it('releases a definitively rejected request once and never resubmits it', async () => {
    const submit = vi.fn(async () => { throw new MusicUpstreamError(400, false); });
    await expect(executeWalletMusicGeneration(prisma, input, submit)).rejects.toMatchObject({ code: 'music_provider_rejected' });
    await expect(executeWalletMusicGeneration(prisma, input, submit)).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(available.toString()).toBe('100'); expect(reserved.toString()).toBe('0');
  });
});
