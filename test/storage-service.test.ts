import { describe, expect, it, vi } from 'vitest';
import { ObjectStorageService, type ObjectStorageConfig } from '../src/modules/storage/service.js';

const baseConfig: ObjectStorageConfig = {
  provider: 'aliyun-oss',
  signedUrlExpiresSeconds: 3_600,
  aliyun: {
    region: 'oss-cn-hongkong',
    bucket: 'test-bucket',
    accessKeyId: 'aliyun-id',
    accessKeySecret: 'aliyun-secret',
  },
  tencent: {
    region: 'ap-singapore',
    bucket: 'inspirationdrawer-1475663212',
    secretId: 'cos-id',
    secretKey: 'cos-secret',
  },
};

function aliyunClient() {
  return {
    put: vi.fn(async (name: string) => ({ name, res: { headers: {}, status: 200 } })),
    head: vi.fn(async () => ({
      status: 200,
      meta: {},
      res: { status: 200, headers: { 'content-length': '5', 'content-type': 'image/png' } },
    })),
    delete: vi.fn(async () => ({ res: { status: 204, headers: {} } })),
    signatureUrl: vi.fn((name: string) => (
      `https://test-bucket.oss-cn-hongkong.aliyuncs.com/${name}?OSSAccessKeyId=id&Signature=signed`
    )),
    getStream: vi.fn(),
  };
}

function tencentClient() {
  return {
    putObject: vi.fn(async () => ({ statusCode: 200, headers: {}, ETag: 'etag' })),
    headObject: vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-length': '5', 'content-type': 'image/png' },
      ETag: 'etag',
    })),
    deleteObject: vi.fn(async () => ({ statusCode: 204, headers: {} })),
    getObjectUrl: vi.fn((input: { Key: string }) => (
      `https://inspirationdrawer-1475663212.cos.ap-singapore.myqcloud.com/${input.Key}`
      + '?q-sign-algorithm=sha1&q-signature=signed'
    )),
    getObjectStream: vi.fn(),
  };
}

describe('object storage abstraction', () => {
  it('keeps Aliyun object key generation and upload paths unchanged', async () => {
    const aliyun = aliyunClient();
    const service = new ObjectStorageService(baseConfig, { aliyun: aliyun as never });

    expect(service.createObjectKey('generated-images', 'result.png'))
      .toBe('generated-images/result.png');
    await expect(service.uploadMedia({
      namespace: 'generated-images',
      filename: 'result.png',
      source: Buffer.from('image'),
      mime: 'image/png',
    })).resolves.toBe('generated-images/result.png');
    expect(aliyun.put).toHaveBeenCalledWith(
      'generated-images/result.png',
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'image/png' }) }),
    );
  });

  it('keeps COS object key generation and upload paths unchanged', async () => {
    const tencent = tencentClient();
    const service = new ObjectStorageService(
      { ...baseConfig, provider: 'tencent-cos' },
      { tencent: tencent as never },
    );

    expect(service.createObjectKey('generated-videos', 'result.mp4'))
      .toBe('generated-videos/result.mp4');
    await expect(service.uploadMedia({
      namespace: 'generated-videos',
      filename: 'result.mp4',
      source: Buffer.from('video'),
      mime: 'video/mp4',
    })).resolves.toBe('generated-videos/result.mp4');
    expect(tencent.putObject).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: 'inspirationdrawer-1475663212',
      Region: 'ap-singapore',
      Key: 'generated-videos/result.mp4',
      ContentType: 'video/mp4',
    }));
  });

  it('extracts object keys only from configured Aliyun and COS endpoints', () => {
    const service = new ObjectStorageService(baseConfig, { aliyun: aliyunClient() as never });

    expect(service.extractObjectKey(
      'https://test-bucket.oss-cn-hongkong.aliyuncs.com/generated-images/a.png?Signature=signed',
    )).toBe('generated-images/a.png');
    expect(service.extractObjectKey(
      'https://inspirationdrawer-1475663212.cos.ap-singapore.myqcloud.com/generated-videos/a.mp4?q-signature=signed',
    )).toBe('generated-videos/a.mp4');
    expect(() => service.extractObjectKey(
      'https://test-bucket.oss-cn-hongkong.aliyuncs.com.evil.example/generated-images/a.png',
    )).toThrow(/does not belong/i);
    expect(() => service.extractObjectKey(
      'https://other-bucket.cos.ap-singapore.myqcloud.com/generated-images/a.png',
    )).toThrow(/does not belong/i);
  });

  it('generates provider-specific signed URLs with the configured expiry', () => {
    const aliyun = aliyunClient();
    const tencent = tencentClient();
    const ossService = new ObjectStorageService(baseConfig, { aliyun: aliyun as never });
    const cosService = new ObjectStorageService(
      { ...baseConfig, provider: 'tencent-cos' },
      { tencent: tencent as never },
    );

    expect(ossService.getDownloadUrl('generated-images/a.png')).toContain('aliyuncs.com');
    expect(aliyun.signatureUrl).toHaveBeenCalledWith(
      'generated-images/a.png',
      expect.objectContaining({ expires: 3_600 }),
    );
    expect(cosService.getDownloadUrl('generated-images/a.png')).toContain('myqcloud.com');
    expect(tencent.getObjectUrl).toHaveBeenCalledWith(expect.objectContaining({
      Key: 'generated-images/a.png',
      Sign: true,
      Expires: 3_600,
    }));
  });

  it('supports exists and delete for both providers without a real bucket', async () => {
    const aliyun = aliyunClient();
    const tencent = tencentClient();
    const ossService = new ObjectStorageService(baseConfig, { aliyun: aliyun as never });
    const cosService = new ObjectStorageService(
      { ...baseConfig, provider: 'tencent-cos' },
      { tencent: tencent as never },
    );

    await expect(ossService.exists('reference-images/a.png')).resolves.toBe(true);
    await expect(ossService.delete('reference-images/a.png')).resolves.toBe(true);
    await expect(cosService.exists('reference-images/a.png')).resolves.toBe(true);
    await expect(cosService.delete('reference-images/a.png')).resolves.toBe(true);
    expect(tencent.headObject).toHaveBeenCalledWith(expect.objectContaining({
      Key: 'reference-images/a.png',
    }));
    expect(tencent.deleteObject).toHaveBeenCalledWith(expect.objectContaining({
      Key: 'reference-images/a.png',
    }));
  });

  it('rewrites historical OSS URLs through the active COS provider without changing keys', () => {
    const tencent = tencentClient();
    const service = new ObjectStorageService(
      { ...baseConfig, provider: 'tencent-cos' },
      { tencent: tencent as never },
    );
    const oldUrl = 'https://test-bucket.oss-cn-hongkong.aliyuncs.com/generated-images/history.png';

    expect(service.normalizeDownloadUrl(oldUrl)).toContain(
      'inspirationdrawer-1475663212.cos.ap-singapore.myqcloud.com/generated-images/history.png',
    );
    expect(service.rewriteStoredUrls({ images: [oldUrl], untouched: 'https://example.com/image.png' }))
      .toEqual({
        images: [expect.stringContaining('/generated-images/history.png?')],
        untouched: 'https://example.com/image.png',
      });
    expect(tencent.getObjectUrl).toHaveBeenCalledWith(expect.objectContaining({
      Key: 'generated-images/history.png',
    }));
  });

  it('rejects invalid filenames, keys, protocols, and signed URL key mismatches', () => {
    const service = new ObjectStorageService(baseConfig, { aliyun: aliyunClient() as never });

    expect(() => service.createObjectKey('generated-images', '../secret.png')).toThrow(/filename/i);
    expect(() => service.exists('../secret.png')).toThrow(/key/i);
    expect(() => service.extractObjectKey(
      'http://test-bucket.oss-cn-hongkong.aliyuncs.com/generated-images/a.png',
    )).toThrow(/does not belong/i);
    expect(() => service.normalizeDownloadUrl(
      'https://example.com/generated-images/a.png',
    )).toThrow(/does not belong/i);
  });
});
