import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  upload: vi.fn(async () => 'generated-images/result.png'),
  exists: vi.fn(async () => true),
  getPublicUrl: vi.fn(() => (
    'https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/generated-images/result.png'
    + '?token=a%2Bb%3D'
  )),
  verifyPublicImageUrl: vi.fn(async () => true),
  delete: vi.fn(async () => true),
}));

vi.mock('../src/modules/ai/image-result-store.js', () => ({
  getImageResult: vi.fn(async () => ({
    path: '/tmp/result.png',
    mime: 'image/png',
    size: 5,
  })),
  imageResultMimeForKey: vi.fn((key: string) => key.endsWith('.png') ? 'image/png' : null),
}));

vi.mock('../src/modules/ai/oss-uploader.js', () => ({
  ossUploadService: bridgeMocks,
}));

import { aiRoutes } from '../src/modules/ai/routes.js';
import { getImageResult } from '../src/modules/ai/image-result-store.js';

async function makeApp() {
  const app = Fastify();
  app.decorate('prisma', {});
  app.decorate('authenticateAccessToken', async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' };
  });
  await app.register(aiRoutes, { prefix: '/v1/ai' });
  return app;
}

describe('generated image OSS delivery route', () => {
  beforeEach(() => {
    bridgeMocks.upload.mockClear();
    bridgeMocks.exists.mockClear();
    bridgeMocks.getPublicUrl.mockClear();
    bridgeMocks.verifyPublicImageUrl.mockClear();
    bridgeMocks.delete.mockClear();
    bridgeMocks.exists.mockResolvedValue(true);
    bridgeMocks.upload.mockImplementation(async (input: { namespace: string; filename: string }) => (
      `${input.namespace}/${input.filename}`
    ));
    bridgeMocks.getPublicUrl.mockImplementation((name: string) => (
      `https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/${name}?token=a%2Bb%3D`
    ));
    vi.mocked(getImageResult).mockResolvedValue({
      path: '/tmp/result.png',
      mime: 'image/png',
      size: 5,
    });
  });

  it('uses the same object key for upload, verification, and signing', async () => {
    bridgeMocks.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const app = await makeApp();
    await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png?redirect=0' });
    expect(bridgeMocks.upload).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'generated-images',
      filename: 'result.png',
    }));
    expect(bridgeMocks.exists).toHaveBeenCalledWith('generated-images/result.png');
    expect(bridgeMocks.getPublicUrl).toHaveBeenCalledWith(
      'generated-images/result.png',
      expect.objectContaining({ mime: 'image/png', download: false }),
    );
    await app.close();
  });

  it('reuses a result that was already mirrored to OSS by the worker', async () => {
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png?redirect=0' });
    expect(response.statusCode).toBe(200);
    expect(bridgeMocks.exists).toHaveBeenCalledWith('generated-images/result.png');
    expect(bridgeMocks.upload).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the default 302 Location intact without double encoding', async () => {
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('token=a%2Bb%3D');
    expect(response.headers.location).not.toContain('%252B');
    await app.close();
  });

  it('returns a signed URL and expiry in redirect=0 mode', async () => {
    const app = await makeApp();
    const before = Date.now();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ai/image-results/result.png?redirect=0',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      url: expect.stringContaining('token=a%2Bb%3D'),
      expiresAt: expect.any(Number),
    });
    expect(response.json().expiresAt).toBeGreaterThan(before + 23 * 60 * 60 * 1_000);
    await app.close();
  });

  it('signs an OSS result even when the API container has no local copy', async () => {
    vi.mocked(getImageResult).mockResolvedValue(null);
    const key = `${'a'.repeat(64)}.png`;
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/ai/image-results/${key}?redirect=0`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      url: expect.stringContaining(`/generated-images/${key}`),
      expiresAt: expect.any(Number),
    });
    expect(bridgeMocks.upload).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a fresh signed OSS URL for a mirrored video result', async () => {
    const key = `${'a'.repeat(64)}.mp4`;
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/ai/video-results/${key}?redirect=0`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      url: expect.stringContaining(`/generated-videos/${key}`),
      expiresAt: expect.any(Number),
    });
    expect(bridgeMocks.exists).toHaveBeenCalledWith(`generated-videos/${key}`);
    expect(bridgeMocks.getPublicUrl).toHaveBeenCalledWith(
      `generated-videos/${key}`,
      expect.objectContaining({ filename: key, download: false }),
    );
    await app.close();
  });

  it('returns an explicit error when OSS upload fails', async () => {
    bridgeMocks.exists.mockResolvedValueOnce(false);
    bridgeMocks.upload.mockRejectedValueOnce(new Error('put failed'));
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png?redirect=0' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'oss_upload_failed',
      message: 'Generated image could not be uploaded to the temporary download bridge',
    });
    await app.close();
  });

  it('returns an explicit error when signing fails', async () => {
    bridgeMocks.getPublicUrl.mockImplementationOnce(() => {
      throw new Error('sign failed');
    });
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png?redirect=0' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'oss_signing_failed',
      message: 'Generated image temporary URL could not be created',
    });
    await app.close();
  });

  it('rejects a missing uploaded object before signing', async () => {
    bridgeMocks.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png?redirect=0' });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('oss_object_missing');
    expect(bridgeMocks.getPublicUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('uploads wallet reference images into the reference-images namespace', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ai/reference-images',
      payload: {
        images: [{
          filename: 'reference.png',
          mime: 'image/png',
          data: Buffer.from('image-bytes').toString('base64'),
        }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      shareId: expect.any(String),
      urls: [expect.stringContaining('/reference-images/')],
    });
    expect(bridgeMocks.upload).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'reference-images',
      mime: 'image/png',
    }));
    expect(bridgeMocks.getPublicUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^reference-images\//),
      expect.objectContaining({ mime: 'image/png' }),
    );
    expect(bridgeMocks.verifyPublicImageUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^reference-images\//),
      expect.stringContaining('/reference-images/'),
    );
    await app.close();
  });

  it('rejects and cleans up an unreadable OSS reference URL before generation', async () => {
    bridgeMocks.verifyPublicImageUrl.mockRejectedValueOnce(
      new Error('OSS signed image URL returned HTTP 403'),
    );
    const app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ai/reference-images',
      payload: {
        images: [{
          filename: 'reference.png',
          mime: 'image/png',
          data: Buffer.from('image-bytes').toString('base64'),
        }],
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'image_delivery_unavailable',
      message: 'Reference image upload is temporarily unavailable',
    });
    expect(bridgeMocks.delete).toHaveBeenCalledWith(
      expect.stringMatching(/^reference-images\//),
    );
    await app.close();
  });
});
