import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMocks = vi.hoisted(() => ({
  getMobileUpdateManifest: vi.fn(async () => ({
    schemaVersion: 1,
    version: '0.1.0',
    apk: {
      url: 'https://api.example.test/v1/mobile/apk',
      sha256: 'a'.repeat(64),
      size: 123,
      architecture: 'arm64-v8a',
    },
  })),
  getMobileUpdateStream: vi.fn(async () => ({
    stream: Buffer.from('apk-bytes'),
    res: { status: 200, headers: { 'content-length': '9' } },
  })),
}));

vi.mock('../src/modules/mobile/update-store.js', () => updateMocks);

import { mobileRoutes } from '../src/modules/mobile/routes.js';

describe('mobile update routes', () => {
  beforeEach(() => {
    updateMocks.getMobileUpdateManifest.mockClear();
    updateMocks.getMobileUpdateStream.mockClear();
  });

  it('serves the manifest through the API without exposing the OSS manifest URL', async () => {
    const app = Fastify();
    await app.register(mobileRoutes, { prefix: '/v1/mobile' });

    const response = await app.inject({ method: 'GET', url: '/v1/mobile/latest' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.json().apk.url).toBe('https://api.example.test/v1/mobile/apk');
    expect(updateMocks.getMobileUpdateStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('streams APK requests through the API instead of public OSS distribution', async () => {
    const app = Fastify();
    await app.register(mobileRoutes, { prefix: '/v1/mobile' });

    const response = await app.inject({ method: 'GET', url: '/v1/mobile/apk' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/vnd.android.package-archive');
    expect(response.headers['content-disposition']).toContain('Inspiration-Drawer-Mobile-arm64.apk');
    expect(response.body).toBe('apk-bytes');
    expect(updateMocks.getMobileUpdateStream).toHaveBeenCalledWith('apk');
    await app.close();
  });

  it('returns a service error when the manifest cannot be read', async () => {
    updateMocks.getMobileUpdateManifest.mockRejectedValueOnce(new Error('OSS unavailable'));
    const app = Fastify();
    await app.register(mobileRoutes, { prefix: '/v1/mobile' });

    const response = await app.inject({ method: 'GET', url: '/v1/mobile/latest' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'mobile_update_unavailable' });
    await app.close();
  });
});
