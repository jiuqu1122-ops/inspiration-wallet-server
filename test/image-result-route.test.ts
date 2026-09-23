import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  isImageResultStorageMirrorPending: vi.fn(() => false),
}));

vi.mock('../src/modules/storage/service.js', () => ({
  storageService: bridgeMocks,
}));

vi.mock('../src/modules/providers/url.js', () => ({
  assertPublicProviderUrl: vi.fn(async () => true),
}));

import { aiRoutes } from '../src/modules/ai/routes.js';
import {
  getImageResult,
  isImageResultStorageMirrorPending,
} from '../src/modules/ai/image-result-store.js';
import { imageResultFallbackStore } from '../src/modules/ai/image-result-fallback.js';

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
  const resultKey = `${'a'.repeat(64)}.png`;
  const objectName = `generated-images/${resultKey}`;
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(56).fill(0)]);
  let resultDirectory = '';
  let resultPath = '';

  beforeAll(async () => {
    resultDirectory = await mkdtemp(join(tmpdir(), 'image-result-route-'));
    resultPath = join(resultDirectory, resultKey);
    await writeFile(resultPath, pngBytes);
  });

  afterAll(async () => {
    await rm(resultDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    bridgeMocks.uploadMedia.mockReset();
    bridgeMocks.exists.mockReset();
    bridgeMocks.getDownloadUrl.mockReset();
    bridgeMocks.verifyImageUrl.mockReset();
    bridgeMocks.createUploadUrl.mockReset();
    bridgeMocks.delete.mockReset();
    bridgeMocks.getObjectStream.mockReset();
    bridgeMocks.headObject.mockReset();
    bridgeMocks.tryResolveObjectKeyFromUrl.mockReset();
    vi.mocked(isImageResultStorageMirrorPending).mockReset().mockReturnValue(false);

    bridgeMocks.exists.mockResolvedValue(true);
    bridgeMocks.uploadMedia.mockImplementation(async (input: { namespace: string; filename: string }) => (
      `${input.namespace}/${input.filename}`
    ));
    bridgeMocks.getDownloadUrl.mockImplementation((name: string) => (
      `https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/${name}?token=a%2Bb%3D`
    ));
    bridgeMocks.verifyImageUrl.mockResolvedValue(true);
    bridgeMocks.createUploadUrl.mockReturnValue({
      url: 'https://inspiration-drawer-prod.oss-cn-hongkong.aliyuncs.com/reference-images/new.png?signature=temp',
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
    });
    bridgeMocks.delete.mockResolvedValue(true);
    bridgeMocks.getObjectStream.mockResolvedValue({
      stream: Readable.from([Buffer.from('image')]),
      statusCode: 200,
      headers: { 'content-length': '5', 'content-type': 'image/png' },
    });
    bridgeMocks.headObject.mockResolvedValue(null);
    bridgeMocks.tryResolveObjectKeyFromUrl.mockReturnValue(null);
    vi.mocked(getImageResult).mockResolvedValue({
      path: resultPath,
      mime: 'image/png',
      size: pngBytes.byteLength,
    });
  });

  it('reuses a result that was already mirrored to COS', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/ai/image-results/${resultKey}?redirect=0`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      url: expect.stringContaining(`/generated-images/${resultKey}`),
      expiresAt: expect.any(Number),
    });
    expect(bridgeMocks.exists).toHaveBeenCalledWith(objectName);
    expect(bridgeMocks.getDownloadUrl).toHaveBeenCalledWith(objectName);
    expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the default COS redirect intact without double encoding', async () => {
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: `/v1/ai/image-results/${resultKey}` });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('token=a%2Bb%3D');
    expect(response.headers.location).not.toContain('%252B');
    expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
    await app.close();
  });

  it('streams the local copy when COS is missing without attempting another upload', async () => {
    bridgeMocks.exists.mockResolvedValue(false);
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: `/v1/ai/image-results/${resultKey}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.rawPayload).toEqual(pngBytes);
    expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
    expect(bridgeMocks.getDownloadUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('serves the local copy without a COS HEAD while its mirror is pending', async () => {
    vi.mocked(isImageResultStorageMirrorPending).mockReturnValue(true);
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: `/v1/ai/image-results/${resultKey}` });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(pngBytes);
    expect(bridgeMocks.exists).not.toHaveBeenCalled();
    await app.close();
  });

  it('falls back to the local copy when COS lookup or signing fails', async () => {
    bridgeMocks.exists.mockRejectedValueOnce(new Error('COS unavailable'));
    const firstApp = await makeApp();
    const lookupResponse = await firstApp.inject({ method: 'GET', url: `/v1/ai/image-results/${resultKey}` });
    expect(lookupResponse.statusCode).toBe(200);
    expect(lookupResponse.rawPayload).toEqual(pngBytes);
    await firstApp.close();

    bridgeMocks.exists.mockResolvedValueOnce(true);
    bridgeMocks.getDownloadUrl.mockImplementationOnce(() => {
      throw new Error('sign failed');
    });
    const secondApp = await makeApp();
    const signingResponse = await secondApp.inject({ method: 'GET', url: `/v1/ai/image-results/${resultKey}` });
    expect(signingResponse.statusCode).toBe(200);
    expect(signingResponse.rawPayload).toEqual(pngBytes);
    expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
    await secondApp.close();
  });

  it('returns only our stable endpoint in redirect=0 mode when serving a fallback', async () => {
    bridgeMocks.exists.mockResolvedValue(false);
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/ai/image-results/${resultKey}?redirect=0`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      url: `https://api.example.test/v1/ai/image-results/${resultKey}`,
      expiresAt: expect.any(Number),
    });
    expect(JSON.stringify(response.json())).not.toContain('oss-cn-hongkong');
    expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
    await app.close();
  });

  it('proxies an encrypted upstream receipt without exposing its signed URL', async () => {
    bridgeMocks.exists.mockResolvedValue(false);
    vi.mocked(getImageResult).mockResolvedValue(null);
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(pngBytes.byteLength),
      });
      response.end(pngBytes);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const source = `http://127.0.0.1:${address.port}/result.png?signature=UPSTREAM_SECRET`;

    try {
      const stableUrl = await imageResultFallbackStore.createFallback(source);
      const fallbackKey = imageResultFallbackStore.keyFromUrl(stableUrl);
      const app = await makeApp();
      const response = await app.inject({ method: 'GET', url: `/v1/ai/image-results/${fallbackKey}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.rawPayload).toEqual(pngBytes);
      expect(JSON.stringify(response.headers)).not.toContain('UPSTREAM_SECRET');

      const metadata = await app.inject({
        method: 'GET',
        url: `/v1/ai/image-results/${fallbackKey}?redirect=0`,
      });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json()).toEqual({ url: stableUrl, expiresAt: expect.any(Number) });
      expect(JSON.stringify(metadata.json())).not.toContain('UPSTREAM_SECRET');
      expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
      await app.close();
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('returns 410 when COS, local storage, and the upstream receipt are all unavailable', async () => {
    bridgeMocks.exists.mockResolvedValue(false);
    vi.mocked(getImageResult).mockResolvedValue(null);
    const missingKey = `${'b'.repeat(64)}.png`;
    const app = await makeApp();
    const response = await app.inject({ method: 'GET', url: `/v1/ai/image-results/${missingKey}` });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: 'image_result_unavailable' });
    expect(bridgeMocks.uploadMedia).not.toHaveBeenCalled();
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
