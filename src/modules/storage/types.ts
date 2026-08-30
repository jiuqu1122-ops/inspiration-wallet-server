import type { Readable } from 'node:stream';

export const STORAGE_PROVIDER_NAMES = ['aliyun-oss', 'tencent-cos'] as const;

export type StorageProviderName = typeof STORAGE_PROVIDER_NAMES[number];

export type StorageUploadInput = {
  objectKey: string;
  source: string | Buffer;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  timeoutMs?: number;
};

export type StorageObjectMetadata = {
  objectKey: string;
  contentLength?: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  metadata: Record<string, string>;
  headers: Record<string, unknown>;
};

export type StorageSignedUrlOptions = {
  expiresSeconds?: number;
  download?: boolean;
  filename?: string;
};

export type StorageObjectStream = {
  stream: Readable;
  statusCode: number;
  headers: Record<string, unknown>;
};

export interface ObjectStorageProvider {
  readonly name: StorageProviderName;
  readonly configured: boolean;
  upload(input: StorageUploadInput): Promise<StorageObjectMetadata>;
  headObject(objectKey: string): Promise<StorageObjectMetadata | null>;
  exists(objectKey: string): Promise<boolean>;
  delete(objectKey: string): Promise<boolean>;
  getPublicUrl(objectKey: string): string;
  getSignedUrl(objectKey: string, options?: StorageSignedUrlOptions): string;
  getDownloadUrl(objectKey: string, options?: StorageSignedUrlOptions): string;
  getObjectStream(objectKey: string): Promise<StorageObjectStream>;
  extractObjectKey(url: string): string | null;
  validateSignedUrl(objectKey: string, url: string): string;
}

export function validateObjectKey(value: string) {
  const objectKey = value.trim();
  const byteLength = Buffer.byteLength(objectKey, 'utf8');
  if (
    objectKey !== value
    || byteLength < 1
    || byteLength > 1_024
    || objectKey.startsWith('/')
    || objectKey.includes('\\')
    || objectKey.includes('?')
    || objectKey.includes('#')
    || [...objectKey].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
    || objectKey.split('/').some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid object storage key');
  }
  return objectKey;
}

export function encodeObjectKey(objectKey: string) {
  return validateObjectKey(objectKey)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

export function objectKeyFromPathname(pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    throw new Error('Invalid object storage URL path encoding');
  }
  return validateObjectKey(decoded);
}

export function headerValue(headers: Record<string, unknown>, name: string) {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && (typeof value === 'string' || typeof value === 'number')) {
      return String(value);
    }
  }
  return undefined;
}

export function metadataFromHeaders(headers: Record<string, unknown>, prefix: string) {
  const expectedPrefix = prefix.toLowerCase();
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => {
      const normalizedKey = key.toLowerCase();
      if (!normalizedKey.startsWith(expectedPrefix) || typeof value !== 'string') return [];
      return [[normalizedKey.slice(expectedPrefix.length), value]];
    }),
  );
}
