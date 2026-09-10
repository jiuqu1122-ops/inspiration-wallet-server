import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const bridgeMocks = vi.hoisted(() => ({
  uploadMedia: vi.fn(async () => 'generated-images/result.png'),
  exists: vi.fn(async () => true),
  getDownloadUrl: vi.fn(() => (
    'https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/generated-images/result.png'
    + '?token=a%2Bb%3D'
  )),
  verifyImageUrl: vi.fn(async () => true),
  createUploadUrl: vi.fn(() => ({
    url: 'https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/reference-images/new.png?signature=temp',
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
  })),
  delete: vi.fn(async () => true),
  rewriteStoredUrls: vi.fn((value: unknown) => value),
  getObjectStream: vi.fn(async () => ({
    stream: Readable.from([Buffer.from('image')]),
    statusCode: 200,
    headers: { 'content-length': '5', 'content-type': 'image/png' },
  })),
  headObject: vi.fn(async () => null),
  tryResolveObjectKeyFromUrl: vi.fn(() => null),
}));

vi.mock('../src/modules/ai/image-result-store.js', () => ({
  getImageResult: vi.fn(async () => ({
    path: '/tmp/result.png',
    mime: 'image/png',
    size: 5,
  })),
  imageResultMimeForKey: vi.fn((key: string) => key.endsWith('.png') ? 'image/png' : null),
}));

vi.mock('../src/modules/storage/service.js', () => ({
  storageService: bridgeMocks,
}));

import { aiRoutes } from '../src/modules/ai/routes.js';
import { getImageResult } from '../src/modules/ai/image-result-store.js';

async function makeApp(prisma: unknown = {}) {
  const app = Fastify();
  app.decorate('prisma', prisma);
  app.decorate('authenticateAccessToken', async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' };
  });
  await app.register(aiRoutes, { prefix: '/v1/ai' });
  return app;
}

describe('generated image OSS delivery route', () => {
  beforeEach(() => {
    bridgeMocks.uploadMedia.mockClear();
    bridgeMocks.exists.mockClear();
    bridgeMocks.getDownloadUrl.mockClear();
    bridgeMocks.verifyImageUrl.mockClear();
    bridgeMocks.createUploadUrl.mockClear();
    bridgeMocks.delete.mockClear();
    bridgeMocks.getObjectStream.mockClear();
    bridgeMocks.exists.mockResolvedValue(true);
    bridgeMocks.uploadMedia.mockImplementation(async (input: { namespace: string; filename: string }) => (
      `${input.namespace}/${input.filename}`
    ));
    bridgeMocks.getDownloadUrl.mockImplementation((name: string) => (
      `https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/${name}?token=a%2Bb%3D`
    ));
    vi.mocked(getImageResult).mockResolvedValue({
      path: '/tmp/result.png',
      mime: 'image/png',
      size: 5,
    });
  });

  it('uses the same object key for availability, upload, and signing', async () => {
    bridgeMocks.exists.mockResolvedValueOnce(false);
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png?redirect=0' });
    expect(response.statusCode).toBe(200);
    expect(bridgeMocks.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'generated-images',
      filename: 'result.png',
    }));
    expect(bridgeMocks.exists).toHaveBeenCalledWith('generated-images/result.png');
    expect(bridgeMocks.exists).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.getDownloadUrl).toHaveBeenCalledWith('generated-images/result.png');
    await app.close();
  });

  it('reuses a result that was already mirrored to OSS by the worker', async () => {
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png?redirect=0' });
    expect(response.statusCode).toBe(200);
    expect(bridgeMocks.exists).toHaveBeenCalledWith('generated-images/result.png');
    expect(bridgeMocks.exists).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
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
    expect(response.json().expiresAt).toBeGreaterThan(before + 59 * 60 * 1_000);
    await app.close();
  });

  it('redirects a whitelisted client engine asset to a signed OSS URL', async () => {
    const app = await makeApp();
    const filename = 'ffmpeg-tools-n8.1-win64-gpl.zip';
    const response = await app.inject({
      method: 'GET',
      url: `/v1/ai/client-assets/${filename}`,
    });
    expect(response.statusCode).toBe(302);
    expect(bridgeMocks.exists).toHaveBeenCalledWith(`client-assets/${filename}`);
    expect(bridgeMocks.getDownloadUrl).toHaveBeenCalledWith(`client-assets/${filename}`);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['x-asset-sha256']).toBe(
      'D4B1D805749E6FA174E4BE158E844AD93BACBF23C2C68EDD473EEBE96B09CA63',
    );
    expect(response.headers['x-asset-size']).toBe('109205730');
    await app.close();
  });

  it('rejects client asset names outside the fixed manifest', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ai/client-assets/unapproved.zip',
    });
    expect(response.statusCode).toBe(404);
    expect(bridgeMocks.exists).not.toHaveBeenCalled();
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
    expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
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
    expect(bridgeMocks.getDownloadUrl).toHaveBeenCalledWith(`generated-videos/${key}`);
    await app.close();
  });

  it('returns an explicit error when OSS upload fails', async () => {
    bridgeMocks.exists.mockResolvedValueOnce(false);
    bridgeMocks.uploadMedia.mockRejectedValueOnce(new Error('put failed'));
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
    bridgeMocks.getDownloadUrl.mockImplementationOnce(() => {
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

  it('does not issue a redundant verification request after a successful upload', async () => {
    bridgeMocks.exists.mockResolvedValueOnce(false);
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/v1/ai/image-results/result.png?redirect=0' });
    expect(response.statusCode).toBe(200);
    expect(bridgeMocks.exists).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.uploadMedia).toHaveBeenCalledOnce();
    expect(bridgeMocks.getDownloadUrl).toHaveBeenCalledWith('generated-images/result.png');
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
    expect(bridgeMocks.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'reference-images',
      mime: 'image/png',
    }));
    expect(bridgeMocks.getDownloadUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^reference-images\//),
    );
    expect(bridgeMocks.verifyImageUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^reference-images\//),
      expect.stringContaining('/reference-images/'),
    );
    await app.close();
  });

  it('issues a short-lived direct upload ticket without returning a server secret', async () => {
    const prisma = {
      referenceUpload: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'upload-1', ...data })),
      },
    };
    const app = await makeApp(prisma);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ai/reference-images/upload-ticket',
      payload: { filename: 'reference.png', mime: 'image/png', sizeBytes: 5 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      objectKey: expect.stringMatching(/^reference-images\//),
      uploadUrl: expect.stringContaining('oss-cn-hongkong.aliyuncs.com'),
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(response.json())).not.toContain('accessKeySecret');
    expect(JSON.stringify(response.json())).not.toContain('secretKey');
    expect(prisma.referenceUpload.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', status: 'ISSUED' }),
    });
    await app.close();
  });

  it('streams an unexpired reference image through the public API proxy', async () => {
    const prisma = {
      referenceUpload: {
        findFirst: vi.fn(async () => ({
          objectKey: 'reference-images/12d2e7bb-6e3f-4ba0-bdb0-b82023a67e23.png',
          contentType: 'image/png',
          sizeBytes: 5,
          status: 'UPLOADED',
        })),
      },
    };
    const app = await makeApp(prisma);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ai/reference-images/content/12d2e7bb-6e3f-4ba0-bdb0-b82023a67e23.png',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-length']).toBe('5');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toBe('image');
    expect(bridgeMocks.getObjectStream).toHaveBeenCalledWith(
      'reference-images/12d2e7bb-6e3f-4ba0-bdb0-b82023a67e23.png',
    );
    await app.close();
  });

  it('does not expose expired or unrecorded reference objects', async () => {
    const prisma = { referenceUpload: { findFirst: vi.fn(async () => null) } };
    const app = await makeApp(prisma);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/ai/reference-images/content/12d2e7bb-6e3f-4ba0-bdb0-b82023a67e23.png',
    });
    expect(response.statusCode).toBe(404);
    expect(bridgeMocks.getObjectStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects and cleans up an unreadable OSS reference URL before generation', async () => {
    bridgeMocks.verifyImageUrl.mockRejectedValueOnce(
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
