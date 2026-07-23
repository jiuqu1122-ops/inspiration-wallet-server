import { basename } from 'node:path';
import OSS from 'ali-oss';
import { env } from '../../config/env.js';

export type OssImageNamespace = 'reference-images' | 'generated-images';

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
    })
  : null;

function requireClient() {
  if (!client) throw new Error('Aliyun OSS public bridge is not configured');
  return client;
}

function objectName(namespace: OssImageNamespace, filename: string) {
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
  namespace: OssImageNamespace;
  filename: string;
  source: string | Buffer;
  mime: string;
}) {
  const name = objectName(input.namespace, input.filename);
  await requireClient().put(name, input.source, {
    headers: {
      'Content-Type': input.mime,
      'Cache-Control': 'private, max-age=86400, immutable',
    },
  });
  return name;
}

export function getPublicUrl(name: string, options?: {
  mime?: string;
  filename?: string;
  download?: boolean;
}) {
  if (!/^(?:reference-images|generated-images)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name)) {
    throw new Error('invalid OSS object name');
  }
  const response: Record<string, string> = {};
  if (options?.mime) response['content-type'] = options.mime;
  if (options?.filename) {
    response['content-disposition'] = `${options.download ? 'attachment' : 'inline'}; filename="${basename(options.filename)}"`;
  }
  return requireClient().signatureUrl(name, {
    expires: name.startsWith('reference-images/')
      ? REFERENCE_URL_EXPIRES_SECONDS
      : GENERATED_URL_EXPIRES_SECONDS,
    ...(Object.keys(response).length > 0 ? { response } : {}),
  });
}

export async function deleteObject(name: string) {
  if (!/^(?:reference-images|generated-images)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name)) {
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
  getPublicUrl,
  delete: deleteObject,
};
