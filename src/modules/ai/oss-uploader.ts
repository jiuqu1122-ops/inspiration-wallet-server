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
      secure: true,
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
  const result = await requireClient().put(name, input.source, {
    headers: {
      'Content-Type': input.mime,
      'Cache-Control': 'private, max-age=86400, immutable',
    },
  });
  if (input.namespace === 'generated-images' && result.name && result.name !== name) {
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
  if (!/^(?:reference-images|generated-images)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name)) {
    throw new Error('invalid OSS object name');
  }
  try {
    await requireClient().head(name);
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
  if (!/^(?:reference-images|generated-images)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name)) {
    throw new Error('invalid OSS object name');
  }
  const response: Record<string, string> = {};
  const isGeneratedImage = name.startsWith('generated-images/');
  // Generated images already have their real Content-Type stored as OSS object
  // metadata. This Bucket rejects signed URLs that try to override it with
  // response-content-type, causing both preview and download to return XML 400.
  if (!isGeneratedImage && options?.mime) response['content-type'] = options.mime;
  if (!isGeneratedImage && options?.filename) {
    response['content-disposition'] = `${options.download ? 'attachment' : 'inline'}; filename="${basename(options.filename)}"`;
  }
  const url = requireClient().signatureUrl(name, {
    expires: name.startsWith('reference-images/')
      ? REFERENCE_URL_EXPIRES_SECONDS
      : GENERATED_URL_EXPIRES_SECONDS,
    ...(Object.keys(response).length > 0 ? { response } : {}),
  });
  return isGeneratedImage ? validateSignedUrl(name, url) : url;
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
  exists,
  getPublicUrl,
  delete: deleteObject,
};
