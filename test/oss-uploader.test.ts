import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
    delete process.env.OSS_REGION;
    delete process.env.OSS_BUCKET;
    delete process.env.OSS_ACCESS_KEY_ID;
    delete process.env.OSS_ACCESS_KEY_SECRET;
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
    expect(ossMocks.head).toHaveBeenCalledWith('generated-images/result.png');
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
      expect.objectContaining({ expires: 1_800 }),
    );
  });
});
