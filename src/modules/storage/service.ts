import { basename } from 'node:path';
import { env, type Environment } from '../../config/env.js';
import { AliyunOssProvider, type AliyunOssClient } from './providers/aliyun-oss.js';
import { TencentCosProvider, type TencentCosClient } from './providers/tencent-cos.js';
import {
  validateObjectKey,
  type ObjectStorageProvider,
  type StorageProviderName,
  type StorageSignedUrlOptions,
  type StorageUploadUrl,
  type StorageUploadUrlOptions,
  type StorageUploadInput,
} from './types.js';

export type StorageMediaNamespace =
  | 'reference-images'
  | 'generated-images'
  | 'generated-videos'
  | 'client-assets';

const SAFE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

export type ObjectStorageConfig = {
  provider: StorageProviderName;
  signedUrlExpiresSeconds: number;
  aliyun: {
    region: string;
    bucket: string;
    accessKeyId: string;
    accessKeySecret: string;
  };
  tencent: {
    region: string;
    bucket: string;
    secretId: string;
    secretKey: string;
  };
};

export type ObjectStorageClients = {
  aliyun?: AliyunOssClient | null;
  tencent?: TencentCosClient | null;
};

export function storageConfigFromEnv(value: Environment): ObjectStorageConfig {
  return {
    provider: value.STORAGE_PROVIDER,
    signedUrlExpiresSeconds: value.STORAGE_SIGNED_URL_EXPIRES_SECONDS,
    aliyun: {
      region: value.OSS_REGION,
      bucket: value.OSS_BUCKET,
      accessKeyId: value.OSS_ACCESS_KEY_ID,
      accessKeySecret: value.OSS_ACCESS_KEY_SECRET,
    },
    tencent: {
      region: value.COS_REGION,
      bucket: value.COS_BUCKET,
      secretId: value.COS_SECRET_ID,
      secretKey: value.COS_SECRET_KEY,
    },
  };
}

export class ObjectStorageService {
  readonly providerName: StorageProviderName;
  private readonly provider: ObjectStorageProvider;
  private readonly urlProviders: ObjectStorageProvider[];
  private readonly internalUrlProviders: ObjectStorageProvider[];

  constructor(
    private readonly config: ObjectStorageConfig,
    clients: ObjectStorageClients = {},
  ) {
    const aliyun = new AliyunOssProvider(config.aliyun, clients.aliyun);
    const tencent = new TencentCosProvider(config.tencent, clients.tencent);
    this.provider = config.provider === 'tencent-cos' ? tencent : aliyun;
    this.providerName = this.provider.name;
    this.urlProviders = this.provider === aliyun ? [aliyun, tencent] : [tencent, aliyun];
    // Only the active provider is an internal URL source. Historical URLs from
    // the configured OSS bucket remain readable after switching to COS because
    // the migrated objects retain the same keys in the active provider.
    this.internalUrlProviders = this.provider === tencent ? [tencent, aliyun] : [aliyun];
  }

  get configured() {
    return this.provider.configured;
  }

  createObjectKey(namespace: StorageMediaNamespace, filename: string) {
    const safeName = basename(filename);
    if (safeName !== filename || !SAFE_FILENAME.test(safeName)) {
      throw new Error('Invalid object storage filename');
    }
    return `${namespace}/${safeName}`;
  }

  upload(input: StorageUploadInput) {
    return this.provider.upload({ ...input, objectKey: validateObjectKey(input.objectKey) });
  }

  uploadMedia(input: {
    namespace: StorageMediaNamespace;
    filename: string;
    source: string | Buffer;
    mime: string;
    metadata?: Record<string, string>;
  }) {
    const objectKey = this.createObjectKey(input.namespace, input.filename);
    return this.upload({
      objectKey,
      source: input.source,
      contentType: input.mime,
      cacheControl: input.namespace === 'client-assets'
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=86400, immutable',
      ...(input.metadata ? { metadata: input.metadata } : {}),
      timeoutMs: input.namespace === 'generated-videos' || input.namespace === 'client-assets'
        ? 10 * 60_000
        : 30_000,
    }).then(() => objectKey);
  }

  headObject(objectKey: string) {
    return this.provider.headObject(validateObjectKey(objectKey));
  }

  exists(objectKey: string) {
    return this.provider.exists(validateObjectKey(objectKey));
  }

  delete(objectKey: string) {
    return this.provider.delete(validateObjectKey(objectKey));
  }

  getPublicUrl(objectKey: string) {
    return this.provider.getPublicUrl(validateObjectKey(objectKey));
  }

  getSignedUrl(objectKey: string, options: StorageSignedUrlOptions = {}) {
    return this.provider.getSignedUrl(validateObjectKey(objectKey), {
      expiresSeconds: options.expiresSeconds ?? this.config.signedUrlExpiresSeconds,
      ...(options.download !== undefined ? { download: options.download } : {}),
      ...(options.filename !== undefined ? { filename: options.filename } : {}),
    });
  }

  getDownloadUrl(objectKey: string, options: StorageSignedUrlOptions = {}) {
    return this.provider.getDownloadUrl(validateObjectKey(objectKey), {
      expiresSeconds: options.expiresSeconds ?? this.config.signedUrlExpiresSeconds,
      ...(options.download !== undefined ? { download: options.download } : {}),
      ...(options.filename !== undefined ? { filename: options.filename } : {}),
    });
  }

  createUploadUrl(objectKey: string, options: StorageUploadUrlOptions): StorageUploadUrl {
    return this.provider.createUploadUrl(validateObjectKey(objectKey), {
      ...options,
      expiresSeconds: options.expiresSeconds ?? this.config.signedUrlExpiresSeconds,
    });
  }

  getObjectStream(objectKey: string) {
    return this.provider.getObjectStream(validateObjectKey(objectKey));
  }

  validateSignedUrl(objectKey: string, url: string) {
    return this.provider.validateSignedUrl(validateObjectKey(objectKey), url);
  }

  tryResolveObjectKeyFromUrl(value: string) {
    if (!/^https:\/\//i.test(value)) return null;
    for (const provider of this.internalUrlProviders) {
      try {
        const objectKey = provider.extractObjectKey(value);
        if (objectKey) return objectKey;
      } catch {
        return null;
      }
    }
    return null;
  }

  async verifyImageUrl(objectKey: string, url: string) {
    const safeUrl = this.validateSignedUrl(objectKey, url);
    const response = await fetch(safeUrl, {
      method: 'GET',
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1',
        range: 'bytes=0-63',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    try {
      if (!response.ok) {
        throw new Error(`Object storage signed image URL returned HTTP ${response.status}`);
      }
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
      if (!mime.startsWith('image/')) {
        throw new Error('Object storage signed URL did not return image content');
      }
      return true;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }

  extractObjectKey(value: string) {
    if (!/^https?:\/\//i.test(value)) return validateObjectKey(value);
    for (const provider of this.urlProviders) {
      try {
        const objectKey = provider.extractObjectKey(value);
        if (objectKey) return objectKey;
      } catch {
        throw new Error('Invalid object storage URL');
      }
    }
    throw new Error('URL does not belong to a configured object storage endpoint');
  }

  normalizeDownloadUrl(value: string, options: StorageSignedUrlOptions = {}) {
    return this.getDownloadUrl(this.extractObjectKey(value), options);
  }

  rewriteStoredUrls(value: unknown): unknown {
    if (typeof value === 'string') {
      if (!/^https:\/\//i.test(value)) return value;
      try {
        return this.normalizeDownloadUrl(value);
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map(item => this.rewriteStoredUrls(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, item]) => [key, this.rewriteStoredUrls(item)]),
      );
    }
    return value;
  }
}

export const storageService = new ObjectStorageService(storageConfigFromEnv(env));
