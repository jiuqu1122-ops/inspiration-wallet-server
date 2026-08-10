import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ossMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  put: vi.fn(async (name: string) => ({ name })),
  head: vi.fn(async () => ({ res: { status: 200 } })),
  delete: vi.fn(async () => ({ res: { status: 204 } })),
  signatureUrl: vi.fn((name: string) => `https://test-bucket.oss-cn-hongkong.aliyuncs.com/${name}?token=a%2Bb%3D`),
}));

vi.mock('ali-oss', () => ({
  default: class MockOss {
    constructor(options: unknown) {
      ossMocks.constructor(options);
    }
    put = ossMocks.put;
    head = ossMocks.head;
    delete = ossMocks.delete;
    signatureUrl = ossMocks.signatureUrl;
  },
}));

describe('OSS public bridge service', () => {
  beforeAll(() => {
    process.env.OSS_REGION = 'oss-cn-hongkong';
    process.env.OSS_BUCKET = 'test-bucket';
    process.env.OSS_ACCESS_KEY_ID = 'test-access-key';
    process.env.OSS_ACCESS_KEY_SECRET = 'test-access-secret';
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.OSS_REGION;
    delete process.env.OSS_BUCKET;
    delete process.env.OSS_ACCESS_KEY_ID;
    delete process.env.OSS_ACCESS_KEY_SECRET;
  });

  beforeEach(() => {
    ossMocks.signatureUrl.mockClear();
  });

  it('uploads generated images and creates a signed URL', async () => {
    const { ossUploadService } = await import('../src/modules/ai/oss-uploader.js');
    const name = await ossUploadService.upload({
      namespace: 'generated-images',
      source: '/tmp/result.png',
      filename: 'result.png',
      mime: 'image/png',
    });
    const url = ossUploadService.getPublicUrl(name, { mime: 'image/png', filename: 'result.png' });

    expect(ossMocks.put).toHaveBeenCalledWith(
      'generated-images/result.png',
      '/tmp/result.png',
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'image/png' }) }),
    );
    expect(ossMocks.constructor).toHaveBeenCalledWith(expect.objectContaining({
      region: 'oss-cn-hongkong',
      bucket: 'test-bucket',
      secure: true,
    }));
    expect(ossMocks.signatureUrl).toHaveBeenCalledWith(
      'generated-images/result.png',
      { expires: 86_400 },
    );
    expect(url).toBe('https://test-bucket.oss-cn-hongkong.aliyuncs.com/generated-images/result.png?token=a%2Bb%3D');
    await expect(ossUploadService.exists(name)).resolves.toBe(true);
    expect(ossMocks.head).toHaveBeenCalledWith(
      'generated-images/result.png',
      { timeout: 15_000 },
    );
  });

  it('uploads generated videos under the video namespace', async () => {
    const { ossUploadService } = await import('../src/modules/ai/oss-uploader.js');
    const name = await ossUploadService.upload({
      namespace: 'generated-videos',
      source: '/tmp/result.mp4',
      filename: 'result.mp4',
      mime: 'video/mp4',
    });
    expect(name).toBe('generated-videos/result.mp4');
    expect(ossMocks.put).toHaveBeenCalledWith(
      'generated-videos/result.mp4',
      '/tmp/result.mp4',
      expect.objectContaining({
        timeout: 10 * 60_000,
        headers: expect.objectContaining({ 'Content-Type': 'video/mp4' }),
      }),
    );
    await expect(ossUploadService.exists(name)).resolves.toBe(true);
  });

  it('supports immutable client engine archives', async () => {
    const { ossUploadService } = await import('../src/modules/ai/oss-uploader.js');
    const name = await ossUploadService.upload({
      namespace: 'client-assets',
      source: '/tmp/engine.zip',
      filename: 'engine.zip',
      mime: 'application/zip',
    });
    expect(name).toBe('client-assets/engine.zip');
    expect(ossMocks.put).toHaveBeenCalledWith(
      'client-assets/engine.zip',
      '/tmp/engine.zip',
      expect.objectContaining({
        timeout: 10 * 60_000,
        headers: expect.objectContaining({
          'Content-Type': 'application/zip',
          'Cache-Control': 'private, max-age=31536000, immutable',
        }),
      }),
    );
    expect(() => ossUploadService.getPublicUrl(name)).not.toThrow();
  });

  it('supports reference image deletion', async () => {
    const { ossUploadService } = await import('../src/modules/ai/oss-uploader.js');
    await expect(ossUploadService.delete('reference-images/share-0.jpg')).resolves.toBe(true);
    expect(ossMocks.delete).toHaveBeenCalledWith('reference-images/share-0.jpg');
  });

  it('limits reference image URLs to 30 minutes', async () => {
    const { ossUploadService } = await import('../src/modules/ai/oss-uploader.js');
    const name = await ossUploadService.upload({
      namespace: 'reference-images',
      source: Buffer.from('image'),
      filename: 'share-1.jpg',
      mime: 'image/jpeg',
    });
    ossUploadService.getPublicUrl(name, { mime: 'image/jpeg', filename: 'share-1.jpg' });
    expect(ossMocks.signatureUrl).toHaveBeenLastCalledWith(
      'reference-images/share-1.jpg',
      { expires: 1_800 },
    );
  });

  it('verifies that a signed reference URL is directly readable as an image', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from('image'), {
      status: 206,
      headers: { 'content-type': 'image/jpeg' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { ossUploadService } = await import('../src/modules/ai/oss-uploader.js');
    const name = 'reference-images/share-2.jpg';
    const url = 'https://test-bucket.oss-cn-hongkong.aliyuncs.com/reference-images/share-2.jpg?token=a%2Bb%3D';
    await expect(ossUploadService.verifyPublicImageUrl(name, url)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({ range: 'bytes=0-63' }),
      }),
    );
  });

  it('reports an unreadable signed URL without exposing its query parameters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const { ossUploadService } = await import('../src/modules/ai/oss-uploader.js');
    const name = 'reference-images/share-3.jpg';
    const url = 'https://test-bucket.oss-cn-hongkong.aliyuncs.com/reference-images/share-3.jpg?token=secret-signature';
    const error = await ossUploadService.verifyPublicImageUrl(name, url).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('HTTP 403');
    expect(error.message).not.toContain('secret-signature');
  });
});
