import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import COS from 'cos-nodejs-sdk-v5';
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

export type TencentCosProviderConfig = {
  region: string;
  bucket: string;
  secretId: string;
  secretKey: string;
};

type TencentCosResult = {
  statusCode?: number;
  headers?: Record<string, unknown>;
  ETag?: string;
};

export type TencentCosClient = {
  putObject(params: COS.PutObjectParams): Promise<TencentCosResult>;
  headObject(params: COS.HeadObjectParams): Promise<TencentCosResult>;
  deleteObject(params: COS.DeleteObjectParams): Promise<TencentCosResult>;
  getObjectUrl(params: COS.GetObjectUrlParams): string;
  getObjectStream(
    params: COS.GetObjectParams,
    callback?: (error: COS.CosError, data: COS.GetObjectResult) => void,
  ): NodeJS.ReadableStream;
};

function isNotFound(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as { statusCode?: unknown; code?: unknown };
  const code = typeof value.code === 'string' ? value.code : '';
  return Number(value.statusCode) === 404
    || ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(code);
}

function headersOf(result: TencentCosResult) {
  return result.headers && typeof result.headers === 'object' ? result.headers : {};
}

export class TencentCosProvider implements ObjectStorageProvider {
  readonly name = 'tencent-cos' as const;
  readonly configured: boolean;
  private readonly client: TencentCosClient | null;

  constructor(
    private readonly config: TencentCosProviderConfig,
    client?: TencentCosClient | null,
  ) {
    this.configured = Boolean(config.region && config.bucket && config.secretId && config.secretKey);
    this.client = client === undefined
      ? this.configured
        ? new COS({
            SecretId: config.secretId,
            SecretKey: config.secretKey,
            Protocol: 'https:',
            Timeout: 10 * 60_000,
          }) as unknown as TencentCosClient
        : null
      : client;
  }

  private requireClient() {
    if (!this.client) throw new Error('Tencent COS is not configured');
    return this.client;
  }

  private endpointHost() {
    if (!this.config.bucket || !this.config.region) {
      throw new Error('Tencent COS endpoint is not configured');
    }
    return `${this.config.bucket}.cos.${this.config.region}.myqcloud.com`.toLowerCase();
  }

  private objectParams(objectKey: string) {
    return {
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: validateObjectKey(objectKey),
    };
  }

  async upload(input: StorageUploadInput) {
    const objectKey = validateObjectKey(input.objectKey);
    const contentLength = typeof input.source === 'string'
      ? (await stat(input.source)).size
      : input.source.byteLength;
    const body = typeof input.source === 'string' ? createReadStream(input.source) : input.source;
    const metadata = Object.fromEntries(
      Object.entries(input.metadata ?? {}).map(([key, value]) => [`x-cos-meta-${key}`, value]),
    ) as Record<`x-cos-meta-${string}`, string>;
    const result = await this.requireClient().putObject({
      ...this.objectParams(objectKey),
      Body: body,
      ContentLength: contentLength,
      ContentType: input.contentType,
      ...(input.cacheControl ? { CacheControl: input.cacheControl } : {}),
      ...metadata,
    });
    return {
      objectKey,
      contentLength,
      ...(result.ETag ? { etag: result.ETag } : {}),
      metadata: metadataFromHeaders(headersOf(result), 'x-cos-meta-'),
      headers: headersOf(result),
    } satisfies StorageObjectMetadata;
  }

  async headObject(value: string) {
    const objectKey = validateObjectKey(value);
    try {
      const result = await this.requireClient().headObject(this.objectParams(objectKey));
      const headers = headersOf(result);
      const contentLength = Number(headerValue(headers, 'content-length'));
      return {
        objectKey,
        ...(Number.isFinite(contentLength) ? { contentLength } : {}),
        ...(headerValue(headers, 'content-type') ? { contentType: headerValue(headers, 'content-type')! } : {}),
        ...(result.ETag || headerValue(headers, 'etag')
          ? { etag: result.ETag || headerValue(headers, 'etag')! }
          : {}),
        ...(headerValue(headers, 'last-modified') ? { lastModified: headerValue(headers, 'last-modified')! } : {}),
        metadata: metadataFromHeaders(headers, 'x-cos-meta-'),
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
      await this.requireClient().deleteObject(this.objectParams(objectKey));
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
    const query = options.download
      ? {
          'response-content-disposition': `attachment${options.filename ? `; filename="${options.filename.replace(/["\\\r\n]/g, '_')}"` : ''}`,
        }
      : undefined;
    const url = this.requireClient().getObjectUrl({
      ...this.objectParams(objectKey),
      Sign: true,
      Protocol: 'https:',
      ...(options.expiresSeconds !== undefined ? { Expires: options.expiresSeconds } : {}),
      ...(query ? { Query: query } : {}),
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
    const stream = this.requireClient().getObjectStream(this.objectParams(objectKey)) as Readable;
    return { stream, statusCode: 200, headers: metadata.headers };
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
      throw new Error('Tencent COS returned an unexpected signed URL');
    }
    return new URL(url).toString();
  }
}
