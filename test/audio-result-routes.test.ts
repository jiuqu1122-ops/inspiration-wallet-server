import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ exists: vi.fn(async () => true), getDownloadUrl: vi.fn((key: string) => `https://cos.example/${key}?signature=${Math.random()}`) }));
vi.mock('../src/modules/storage/service.js', () => ({ storageService: storage }));
import { aiRoutes } from '../src/modules/ai/routes.js';

describe('stable audio result access', () => {
  const app = Fastify();
  const key = `${'b'.repeat(64)}.mp3`;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => storage.exists.mockResolvedValue(true));
  beforeAll(async () => {
    app.decorate('authenticateAccessToken', async () => {});
    await app.register(aiRoutes, { prefix: '/v1/ai' });
  });
  afterAll(() => app.close());
  it('renews COS signatures for playback, seeking, HEAD and video references', async () => {
    const first = await app.inject({ method: 'GET', url: `/v1/ai/audio-results/${key}`, headers: { range: 'bytes=0-1023' } });
    const second = await app.inject({ method: 'HEAD', url: `/v1/ai/audio-results/${key}` });
    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    expect(first.headers.location).toContain(`generated-audios/${key}`);
    expect(second.headers.location).not.toBe(first.headers.location);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(second.body).toBe('');
  });
  it('returns a fresh signed URL to API consumers when requested', async () => {
    const response = await app.inject(`/v1/ai/audio-results/${key}?redirect=0`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ url: expect.stringContaining(`generated-audios/${key}`), expiresAt: expect.any(Number) });
  });
  it('rejects arbitrary keys and missing objects', async () => {
    const invalid = await app.inject('/v1/ai/audio-results/other.mp3');
    expect(invalid.statusCode).toBe(404);
    expect(storage.exists).not.toHaveBeenCalled();
    storage.exists.mockResolvedValueOnce(false);
    expect((await app.inject(`/v1/ai/audio-results/${key}`)).statusCode).toBe(404);
  });
  it('signs downloads as attachments while leaving playback and video references inline', async () => {
    expect((await app.inject(`/v1/ai/audio-results/${key}?download=1`)).statusCode).toBe(302);
    expect(storage.getDownloadUrl).toHaveBeenLastCalledWith(`generated-audios/${key}`, { download: true, filename: 'music.mp3' });
    await app.inject(`/v1/ai/audio-results/${key}`);
    expect(storage.getDownloadUrl).toHaveBeenLastCalledWith(`generated-audios/${key}`, undefined);
  });
  it('returns a recoverable error without exposing storage details', async () => {
    storage.exists.mockRejectedValueOnce(new Error('secret storage details'));
    const response = await app.inject(`/v1/ai/audio-results/${key}`);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('secret');
  });
});
