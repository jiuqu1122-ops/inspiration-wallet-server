import { basename } from 'node:path';
import OSS from 'ali-oss';
import { env } from '../../config/env.js';

export type OssMediaNamespace = 'reference-images' | 'generated-images' | 'generated-videos';

const REFERENCE_URL_EXPIRES_SECONDS = 30 * 60;
const GENERATED_URL_EXPIRES_SECONDS = 24 * 60 * 60;
const SAFE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

const configured = Boolean(
  env.OSS_REGION
  && env.OSS_BUCKET
  && env.OSS_ACCESS_KEY_ID
  && env.OSS_ACCESS_KEY_SECRET,
);

const client = configured
  ? new OSS({
      region: env.OSS_REGION,
      bucket: env.OSS_BUCKET,
      accessKeyId: env.OSS_ACCESS_KEY_ID,
      accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
      secure: true,
    })
  : null;

function requireClient() {
  if (!client) throw new Error('Aliyun OSS public bridge is not configured');
  return client;
}

function objectName(namespace: OssMediaNamespace, filename: string) {
  const safeName = basename(filename);
  if (safeName !== filename || !SAFE_FILENAME.test(safeName)) {
    throw new Error('invalid OSS image filename');
  }
  return `${namespace}/${safeName}`;
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return Number(value.statusCode || value.status) === 404
    || ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(String(value.code || ''));
}

export async function upload(input: {
  namespace: OssMediaNamespace;
  filename: string;
  source: string | Buffer;
  mime: string;
}) {
  const name = objectName(input.namespace, input.filename);
  const result = await requireClient().put(name, input.source, {
    timeout: input.namespace === 'generated-videos' ? 10 * 60_000 : 30_000,
    headers: {
      'Content-Type': input.mime,
      'Cache-Control': 'private, max-age=86400, immutable',
    },
  });
  if ((input.namespace === 'generated-images' || input.namespace === 'generated-videos')
    && result.name && result.name !== name) {
    throw new Error('OSS returned an unexpected object key');
  }
  return name;
}

function validateSignedUrl(name: string, signedUrl: string) {
  const parsed = new URL(signedUrl);
  const expectedHost = `${env.OSS_BUCKET}.${env.OSS_REGION}.aliyuncs.com`.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== expectedHost) {
    throw new Error('OSS returned an unexpected signed URL endpoint');
  }
  if (decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) !== name) {
    throw new Error('OSS signed URL object key does not match the uploaded object');
  }
  return parsed.toString();
}

export async function exists(name: string) {
  if (!/^(?:reference-images|generated-images|generated-videos)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name)) {
    throw new Error('invalid OSS object name');
  }
  try {
    await requireClient().head(name, { timeout: 15_000 });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function getPublicUrl(name: string, options?: {
  mime?: string;
  filename?: string;
  download?: boolean;
}) {
  if (!/^(?:reference-images|generated-images|generated-videos)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name)) {
    throw new Error('invalid OSS object name');
  }
  // Media Content-Type is stored as OSS object metadata during upload. This
  // Bucket rejects signed URLs that override response headers, so neither
  // generated images nor reference images may add response-content-* params.
  void options;
  const url = requireClient().signatureUrl(name, {
    expires: name.startsWith('reference-images/')
      ? REFERENCE_URL_EXPIRES_SECONDS
      : GENERATED_URL_EXPIRES_SECONDS,
  });
  return validateSignedUrl(name, url);
}

export async function verifyPublicImageUrl(name: string, url: string) {
  const safeUrl = validateSignedUrl(name, url);
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
      throw new Error(`OSS signed image URL returned HTTP ${response.status}`);
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || '';
    if (!mime.startsWith('image/')) {
      throw new Error('OSS signed image URL did not return image content');
    }
    return true;
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

export async function deleteObject(name: string) {
  if (!/^(?:reference-images|generated-images|generated-videos)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name)) {
    throw new Error('invalid OSS object name');
  }
  try {
    await requireClient().delete(name);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export const ossUploadService = {
  upload,
  exists,
  getPublicUrl,
  verifyPublicImageUrl,
  delete: deleteObject,
};
