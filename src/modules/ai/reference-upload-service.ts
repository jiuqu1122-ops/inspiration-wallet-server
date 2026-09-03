import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { storageService } from '../storage/service.js';
import {
  headerValue,
  validateObjectKey,
  type StorageObjectStream,
  type StorageUploadUrl,
} from '../storage/types.js';

export const REFERENCE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const REFERENCE_UPLOAD_TTL_SECONDS = 5 * 60;
const REFERENCE_IMAGE_FILENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:-\d+)?\.(?:png|jpe?g|webp|gif)$/i;

export const referenceUploadInputSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  sizeBytes: z.number().int().positive().max(REFERENCE_UPLOAD_MAX_BYTES),
}).strict();

export type ReferenceUploadInput = z.infer<typeof referenceUploadInputSchema>;

export class ReferenceUploadError extends Error {
  constructor(
    message: string,
    public readonly code = 'invalid_reference_image',
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'ReferenceUploadError';
  }
}

function extensionForMime(mime: string) {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'png';
  }
}

function referenceObjectKey(mime: string) {
  return `reference-images/${randomUUID()}.${extensionForMime(mime)}`;
}

type ReferenceUploadRecord = {
  id: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number | bigint;
  status: string;
};

function delegate(prisma: PrismaClient) {
  const value = (prisma as PrismaClient & { referenceUpload?: unknown }).referenceUpload;
  if (!value || typeof value !== 'object') {
    throw new Error('Reference upload ownership storage is unavailable');
  }
  return value as unknown as {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findFirst(args: { where: Record<string, unknown> }): Promise<ReferenceUploadRecord | null>;
    update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
  };
}

export async function issueReferenceUploadTicket(
  prisma: PrismaClient,
  userId: string,
  input: ReferenceUploadInput,
) {
  if (input.sizeBytes > REFERENCE_UPLOAD_MAX_BYTES) {
    throw new ReferenceUploadError('Reference image exceeds the size limit', 'reference_image_too_large', 413);
  }
  const objectKey = referenceObjectKey(input.mime);
  const expiresAt = new Date(Date.now() + REFERENCE_UPLOAD_TTL_SECONDS * 1_000);
  const upload = storageService.createUploadUrl(objectKey, {
    expiresSeconds: REFERENCE_UPLOAD_TTL_SECONDS,
    contentType: input.mime,
  });
  await delegate(prisma).create({
    data: {
      userId,
      objectKey,
      contentType: input.mime,
      sizeBytes: input.sizeBytes,
      status: 'ISSUED',
      expiresAt,
    },
  });
  return {
    objectKey,
    uploadUrl: upload.url,
    method: upload.method,
    headers: upload.headers,
    expiresAt: expiresAt.toISOString(),
  } satisfies {
    objectKey: string;
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  };
}

export async function recordLegacyReferenceUpload(
  prisma: PrismaClient,
  userId: string,
  objectKey: string,
  contentType: string,
  sizeBytes: number,
) {
  await delegate(prisma).create({
    data: {
      userId,
      objectKey: validateReferenceObjectKey(objectKey),
      contentType,
      sizeBytes,
      status: 'UPLOADED',
      expiresAt: new Date(Date.now() + Math.max(
        REFERENCE_UPLOAD_TTL_SECONDS,
        env.STORAGE_SIGNED_URL_EXPIRES_SECONDS,
      ) * 1_000),
      uploadedAt: new Date(),
    },
  });
}

export function validateReferenceObjectKey(value: string) {
  let objectKey: string;
  try {
    objectKey = validateObjectKey(value);
  } catch {
    throw new ReferenceUploadError('Reference object key is invalid');
  }
  if (!objectKey.startsWith('reference-images/') || objectKey.length <= 'reference-images/'.length) {
    throw new ReferenceUploadError('Reference object key must use the reference-images namespace');
  }
  return objectKey;
}

function isDataImage(value: string) {
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\s]+$/i.test(value);
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

export async function authorizeReferenceObject(
  prisma: PrismaClient,
  userId: string,
  objectKey: string,
  requireOwnership = true,
) {
  const normalizedKey = validateReferenceObjectKey(objectKey);
  const record = await delegate(prisma).findFirst({
    where: {
      userId,
      objectKey: normalizedKey,
      status: { in: ['ISSUED', 'UPLOADED'] },
      expiresAt: { gt: new Date() },
    },
  });
  if (!record && requireOwnership) {
    throw new ReferenceUploadError('Reference image upload is not owned by this user or has expired');
  }
  const metadata = await storageService.headObject(normalizedKey);
  if (!metadata) {
    throw new ReferenceUploadError('Reference image object was not uploaded', 'reference_image_not_uploaded', 422);
  }
  const actualSize = metadata.contentLength;
  if (typeof actualSize !== 'number' || !Number.isFinite(actualSize) || actualSize <= 0 || actualSize > REFERENCE_UPLOAD_MAX_BYTES) {
    throw new ReferenceUploadError('Reference image object size is invalid', 'reference_image_invalid', 422);
  }
  if (record && actualSize !== Number(record.sizeBytes)) {
    throw new ReferenceUploadError('Reference image object size does not match the upload ticket', 'reference_image_invalid', 422);
  }
  const actualMime = metadata.contentType?.split(';')[0]?.trim().toLowerCase();
  if (!actualMime || (record && actualMime !== String(record.contentType).toLowerCase())) {
    throw new ReferenceUploadError('Reference image MIME type does not match the upload ticket', 'reference_image_invalid', 422);
  }
  if (record && String(record.status) !== 'UPLOADED') {
    await delegate(prisma).update({
      where: { id: record.id },
      data: { status: 'UPLOADED', uploadedAt: new Date() },
    });
  }
  return normalizedKey;
}

export function referenceImageProxyUrl(objectKey: string) {
  const normalizedKey = validateReferenceObjectKey(objectKey);
  const filename = normalizedKey.slice('reference-images/'.length);
  if (!REFERENCE_IMAGE_FILENAME_PATTERN.test(filename)) {
    throw new ReferenceUploadError('Reference image filename is invalid');
  }
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/reference-images/content/${encodeURIComponent(filename)}`;
}

function ownReferenceObjectKey(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('reference-images/')) return trimmed;
  if (!isHttpUrl(trimmed)) return null;
  const objectKey = storageService.tryResolveObjectKeyFromUrl(trimmed);
  return objectKey?.startsWith('reference-images/') ? objectKey : null;
}

/**
 * Converts private storage references in OpenAI-compatible multimodal messages
 * into short-lived API proxy URLs. The upstream model never needs direct COS
 * access, while unrelated public image URLs and data URLs remain untouched.
 */
export async function proxyAgentChatReferenceImages(
  prisma: PrismaClient,
  userId: string,
  messages: unknown[],
) {
  const authorizationCache = new Map<string, Promise<string>>();
  const authorize = (objectKey: string) => {
    const cached = authorizationCache.get(objectKey);
    if (cached) return cached;
    const pending = authorizeReferenceObject(prisma, userId, objectKey);
    authorizationCache.set(objectKey, pending);
    return pending;
  };

  return Promise.all(messages.map(async (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.content)) return message;
    const originalContent = record.content as unknown[];
    let changed = false;
    const content = await Promise.all(originalContent.map(async (part: unknown): Promise<unknown> => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
      const contentPart = part as Record<string, unknown>;
      if (contentPart.type !== 'image_url') return part;
      const imageUrl = contentPart.image_url;
      if (!imageUrl || typeof imageUrl !== 'object' || Array.isArray(imageUrl)) return part;
      const imageUrlRecord = imageUrl as Record<string, unknown>;
      if (typeof imageUrlRecord.url !== 'string') return part;
      const objectKey = ownReferenceObjectKey(imageUrlRecord.url);
      if (!objectKey) return part;
      const authorizedKey = await authorize(objectKey);
      changed = true;
      return {
        ...contentPart,
        image_url: {
          ...imageUrlRecord,
          url: referenceImageProxyUrl(authorizedKey),
        },
      };
    }));
    return changed ? { ...record, content } : message;
  }));
}

export type ReferenceImageContent = {
  objectKey: string;
  contentType: string;
  contentLength: number;
  response: StorageObjectStream;
};

export async function getReferenceImageContent(
  prisma: PrismaClient,
  filename: string,
): Promise<ReferenceImageContent> {
  if (!REFERENCE_IMAGE_FILENAME_PATTERN.test(filename)) {
    throw new ReferenceUploadError('Reference image not found', 'reference_image_not_found', 404);
  }
  const objectKey = validateReferenceObjectKey(`reference-images/${filename}`);
  const record = await delegate(prisma).findFirst({
    where: {
      objectKey,
      status: { in: ['ISSUED', 'UPLOADED'] },
      expiresAt: { gt: new Date() },
    },
  });
  const contentType = (String(record?.contentType || '').split(';')[0] || '').trim().toLowerCase();
  const contentLength = Number(record?.sizeBytes);
  if (!record
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)
    || !Number.isInteger(contentLength)
    || contentLength <= 0
    || contentLength > REFERENCE_UPLOAD_MAX_BYTES) {
    throw new ReferenceUploadError('Reference image not found or expired', 'reference_image_not_found', 404);
  }
  const response = await storageService.getObjectStream(objectKey);
  const upstreamLength = Number(headerValue(response.headers, 'content-length'));
  const upstreamType = headerValue(response.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase();
  if ((Number.isFinite(upstreamLength) && upstreamLength !== contentLength)
    || (upstreamType && upstreamType !== contentType)) {
    response.stream.destroy();
    throw new ReferenceUploadError('Reference image metadata is invalid', 'reference_image_invalid', 422);
  }
  return { objectKey, contentType, contentLength, response };
}

export async function resolveReferenceImageSources(
  prisma: PrismaClient,
  userId: string,
  sources: string[],
) {
  const resolved: string[] = [];
  for (const source of sources) {
    const trimmed = source.trim();
    if (!trimmed) throw new ReferenceUploadError('Reference image is empty');
    if (isDataImage(trimmed)) {
      resolved.push(trimmed);
      continue;
    }
    if (isHttpUrl(trimmed)) {
      const objectKey = storageService.tryResolveObjectKeyFromUrl(trimmed);
      if (!objectKey) {
        resolved.push(trimmed);
        continue;
      }
      // Existing generated media URLs are already handled by the storage-aware
      // provider paths in image-service. Only reference upload URLs participate
      // in the new ticket ownership protocol; do not reinterpret generated
      // objects as reference uploads.
      if (!objectKey.startsWith('reference-images/')) {
        resolved.push(trimmed);
        continue;
      }
      const authorizedKey = await authorizeReferenceObject(prisma, userId, objectKey, false);
      resolved.push(storageService.getDownloadUrl(authorizedKey));
      continue;
    }
    const authorizedKey = await authorizeReferenceObject(prisma, userId, trimmed);
    resolved.push(storageService.getDownloadUrl(authorizedKey));
  }
  return resolved;
}

export function uploadUrlFromProvider(value: StorageUploadUrl) {
  return value;
}

export function referenceImageExtension(mime: string) {
  return extensionForMime(mime);
}
