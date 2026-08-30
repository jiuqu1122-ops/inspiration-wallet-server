import type { Readable } from 'node:stream';
import OSS from 'ali-oss';
import {
  encodeObjectKey,
  headerValue,
  metadataFromHeaders,
  objectKeyFromPathname,
  validateObjectKey,
  type ObjectStorageProvider,
  type StorageObjectMetadata,
  type StorageSignedUrlOptions,
  type StorageUploadInput,
} from '../types.js';

export type AliyunOssProviderConfig = {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
};

export type AliyunOssClient = Pick<OSS, 'put' | 'head' | 'delete' | 'signatureUrl' | 'getStream'>;

function isNotFound(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const code = typeof value.code === 'string' ? value.code : '';
  return Number(value.statusCode || value.status) === 404
    || ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(code);
}

function responseHeaders(value: unknown) {
  if (!value || typeof value !== 'object') return {};
  const headers = (value as { headers?: unknown }).headers;
  return headers && typeof headers === 'object' ? headers as Record<string, unknown> : {};
}

export class AliyunOssProvider implements ObjectStorageProvider {
  readonly name = 'aliyun-oss' as const;
  readonly configured: boolean;
  private readonly client: AliyunOssClient | null;

  constructor(
    private readonly config: AliyunOssProviderConfig,
    client?: AliyunOssClient | null,
  ) {
    this.configured = Boolean(
      config.region && config.bucket && config.accessKeyId && config.accessKeySecret,
    );
    this.client = client === undefined
      ? this.configured
        ? new OSS({
            region: config.region,
            bucket: config.bucket,
            accessKeyId: config.accessKeyId,
            accessKeySecret: config.accessKeySecret,
            secure: true,
          })
        : null
      : client;
  }

  private requireClient() {
    if (!this.client) throw new Error('Aliyun OSS is not configured');
    return this.client;
  }

  private endpointHost() {
    if (!this.config.bucket || !this.config.region) {
      throw new Error('Aliyun OSS endpoint is not configured');
    }
    return `${this.config.bucket}.${this.config.region}.aliyuncs.com`.toLowerCase();
  }

  async upload(input: StorageUploadInput) {
    const objectKey = validateObjectKey(input.objectKey);
    const result = await this.requireClient().put(objectKey, input.source, {
      ...(input.timeoutMs !== undefined ? { timeout: input.timeoutMs } : {}),
      headers: {
        'Content-Type': input.contentType,
        ...(input.cacheControl ? { 'Cache-Control': input.cacheControl } : {}),
        ...Object.fromEntries(
          Object.entries(input.metadata ?? {}).map(([key, value]) => [`x-oss-meta-${key}`, value]),
        ),
      },
    });
    if (result.name && result.name !== objectKey) {
      throw new Error('Aliyun OSS returned an unexpected object key');
    }
    return {
      objectKey,
      metadata: metadataFromHeaders(responseHeaders(result.res), 'x-oss-meta-'),
      headers: responseHeaders(result.res),
    } satisfies StorageObjectMetadata;
  }

  async headObject(value: string) {
    const objectKey = validateObjectKey(value);
    try {
      const result = await this.requireClient().head(objectKey, { timeout: 15_000 });
      const headers = responseHeaders(result.res);
      const contentLength = Number(headerValue(headers, 'content-length'));
      return {
        objectKey,
        ...(Number.isFinite(contentLength) ? { contentLength } : {}),
        ...(headerValue(headers, 'content-type') ? { contentType: headerValue(headers, 'content-type')! } : {}),
        ...(headerValue(headers, 'etag') ? { etag: headerValue(headers, 'etag')! } : {}),
        ...(headerValue(headers, 'last-modified') ? { lastModified: headerValue(headers, 'last-modified')! } : {}),
        metadata: {
          ...metadataFromHeaders(headers, 'x-oss-meta-'),
          ...Object.fromEntries(
            Object.entries(result.meta ?? {}).flatMap(([key, value]) => (
              typeof value === 'string' ? [[key.toLowerCase(), value]] : []
            )),
          ),
        },
        headers,
      } satisfies StorageObjectMetadata;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async exists(objectKey: string) {
    return (await this.headObject(objectKey)) !== null;
  }

  async delete(value: string) {
    const objectKey = validateObjectKey(value);
    try {
      await this.requireClient().delete(objectKey);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  getPublicUrl(value: string) {
    const objectKey = encodeObjectKey(value);
    return `https://${this.endpointHost()}/${objectKey}`;
  }

  getSignedUrl(value: string, options: StorageSignedUrlOptions = {}) {
    const objectKey = validateObjectKey(value);
    const url = this.requireClient().signatureUrl(objectKey, {
      ...(options.expiresSeconds !== undefined ? { expires: options.expiresSeconds } : {}),
      ...(options.download
        ? { response: { 'content-disposition': `attachment${options.filename ? `; filename="${options.filename.replace(/["\\\r\n]/g, '_')}"` : ''}` } }
        : {}),
    });
    return this.validateSignedUrl(objectKey, url);
  }

  getDownloadUrl(objectKey: string, options: StorageSignedUrlOptions = {}) {
    return this.getSignedUrl(objectKey, options);
  }

  async getObjectStream(value: string) {
    const objectKey = validateObjectKey(value);
    const metadata = await this.headObject(objectKey);
    if (!metadata) throw Object.assign(new Error('Object storage object was not found'), { statusCode: 404 });
    const result = await this.requireClient().getStream(objectKey, { timeout: 10 * 60_000 });
    if (!result.stream || result.res.status !== 200) {
      throw new Error(`Aliyun OSS object returned HTTP ${result.res.status}`);
    }
    return {
      stream: result.stream as Readable,
      statusCode: result.res.status,
      headers: responseHeaders(result.res),
    };
  }

  extractObjectKey(value: string) {
    if (!this.config.bucket || !this.config.region) return null;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== this.endpointHost()) return null;
    return objectKeyFromPathname(parsed.pathname);
  }

  validateSignedUrl(objectKey: string, url: string) {
    const extracted = this.extractObjectKey(url);
    if (!extracted || extracted !== validateObjectKey(objectKey)) {
      throw new Error('Aliyun OSS returned an unexpected signed URL');
    }
    return new URL(url).toString();
  }
}
