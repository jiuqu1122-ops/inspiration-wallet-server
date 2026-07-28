import OSS from 'ali-oss';
import { env } from '../../config/env.js';

const PREVIEW_URL_EXPIRES_SECONDS = 6 * 60 * 60;
const SAFE_ID = /^[a-zA-Z0-9-]{16,80}$/;
const SAFE_OBJECT_KEY = /^inspiration-space\/[a-zA-Z0-9-]{16,80}\/previews\/[a-zA-Z0-9-]{16,80}\.(?:jpg|png|webp)$/;

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
  if (!client) throw new Error('Aliyun OSS is not configured for inspiration space previews');
  return client;
}

function extensionForMime(mimeType: string) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  throw new Error('Unsupported inspiration space preview format');
}

function validateObjectKey(objectKey: string) {
  if (!SAFE_OBJECT_KEY.test(objectKey)) {
    throw new Error('Invalid inspiration space preview object key');
  }
  return objectKey;
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return Number(value.statusCode || value.status) === 404
    || ['NoSuchKey', 'NoSuchObject', 'NotFound'].includes(String(value.code || ''));
}

function validateSignedUrl(objectKey: string, signedUrl: string) {
  const parsed = new URL(signedUrl);
  const expectedHost = `${env.OSS_BUCKET}.${env.OSS_REGION}.aliyuncs.com`.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== expectedHost) {
    throw new Error('OSS returned an unexpected inspiration space endpoint');
  }
  if (decodeURIComponent(parsed.pathname.replace(/^\/+/, '')) !== objectKey) {
    throw new Error('OSS inspiration space object key mismatch');
  }
  return parsed.toString();
}

export async function uploadInspirationPreview(input: {
  shareId: string;
  previewId: string;
  bytes: Buffer;
  mimeType: string;
}) {
  if (!SAFE_ID.test(input.shareId) || !SAFE_ID.test(input.previewId)) {
    throw new Error('Invalid inspiration space preview identifier');
  }
  const objectKey = `inspiration-space/${input.shareId}/previews/${input.previewId}.${extensionForMime(input.mimeType)}`;
  const result = await requireClient().put(objectKey, input.bytes, {
    headers: {
      'Content-Type': input.mimeType,
      'Cache-Control': 'private, max-age=21600, immutable',
    },
  });
  if (result.name && result.name !== objectKey) {
    throw new Error('OSS returned an unexpected inspiration space object key');
  }
  return objectKey;
}

export function getInspirationPreviewUrl(objectKey: string) {
  const safeKey = validateObjectKey(objectKey);
  const signedUrl = requireClient().signatureUrl(safeKey, {
    expires: PREVIEW_URL_EXPIRES_SECONDS,
  });
  return validateSignedUrl(safeKey, signedUrl);
}

export async function deleteInspirationPreview(objectKey: string) {
  const safeKey = validateObjectKey(objectKey);
  try {
    await requireClient().delete(safeKey);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
