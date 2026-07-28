import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import {
  deleteInspirationPreview,
  getInspirationPreviewUrl,
  uploadInspirationPreview,
} from './asset-store.js';

export const INSPIRATION_SHARE_KINDS = ['NODE_PRESET', 'WORKFLOW'] as const;
export const INSPIRATION_SHARE_STATUSES = ['PENDING', 'PUBLISHED', 'REJECTED'] as const;
export type InspirationShareKind = typeof INSPIRATION_SHARE_KINDS[number];
export type InspirationShareStatus = typeof INSPIRATION_SHARE_STATUSES[number];

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 900 * 1024;

type PreviewInput = {
  dataUrl: string;
  width: number;
  height: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function classifyCandidate(value: unknown, result: Set<InspirationShareKind>) {
  if (!isRecord(value)) return;
  if (typeof value.label === 'string' && typeof value.prompt === 'string') {
    result.add('NODE_PRESET');
  }
  if (typeof value.label === 'string' && Array.isArray(value.nodes)) {
    result.add('WORKFLOW');
  }
}

export function classifyInspirationPayload(value: unknown) {
  const result = new Set<InspirationShareKind>();
  if (Array.isArray(value)) {
    value.forEach((candidate) => classifyCandidate(candidate, result));
    return [...result];
  }
  if (!isRecord(value)) return [];

  if (value.type === 'inspiration-drawer-workflow-instance' && isRecord(value.workflow)) {
    classifyCandidate(value.workflow, result);
    return [...result];
  }
  if (Array.isArray(value.presets)) {
    value.presets.forEach((candidate) => classifyCandidate(candidate, result));
  }
  if (Array.isArray(value.workflows)) {
    value.workflows.forEach((candidate) => classifyCandidate(candidate, result));
  }
  if (isRecord(value.preset)) classifyCandidate(value.preset, result);
  if (isRecord(value.workflow)) classifyCandidate(value.workflow, result);
  if (result.size === 0) classifyCandidate(value, result);
  return [...result];
}

function imageMimeAndBytes(dataUrl: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match) throw new Error('Preview image must be a JPEG, PNG, or WebP data URL');
  const mimeType = match[1];
  const encoded = match[2]!.replace(/\s+/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_PREVIEW_BYTES) {
    throw new Error('Preview image must be between 1 byte and 900 KB after compression');
  }
  const validMagic = (
    (mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8)
    || (mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (
      mimeType === 'image/webp'
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  );
  if (!validMagic) throw new Error('Preview image content does not match its declared format');
  return { mimeType, bytes };
}

export function validateInspirationSubmission(input: {
  kind: InspirationShareKind;
  payload: unknown;
  previews: PreviewInput[];
}) {
  const jsonText = JSON.stringify(input.payload);
  if (!jsonText || Buffer.byteLength(jsonText, 'utf8') > MAX_JSON_BYTES) {
    throw new Error('Shared JSON must not exceed 8 MB after image compression');
  }
  const kinds = classifyInspirationPayload(input.payload);
  if (!kinds.includes(input.kind)) {
    throw new Error('JSON content does not match the selected preset or workflow type');
  }
  return input.previews.map((preview) => ({
    ...preview,
    ...imageMimeAndBytes(preview.dataUrl),
  }));
}

function safeJsonFilename(value: string) {
  const stem = value
    .replace(/\.json$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
    .slice(0, 120) || 'inspiration-share';
  return `${stem}.json`;
}

function previewApiUrl(previewId: string) {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/inspiration-space/assets/${encodeURIComponent(previewId)}`;
}

function serializeShare(share: {
  id: string;
  kind: string;
  status: string;
  title: string;
  description: string | null;
  authorName: string;
  tags: string[];
  fileName: string;
  downloadCount: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  previews: Array<{
    id: string;
    mimeType: string;
    width: number;
    height: number;
    sizeBytes: number;
    sortOrder: number;
  }>;
}) {
  return {
    id: share.id,
    kind: share.kind,
    status: share.status,
    title: share.title,
    description: share.description,
    authorName: share.authorName,
    tags: share.tags,
    fileName: share.fileName,
    downloadCount: share.downloadCount,
    createdAt: share.createdAt.toISOString(),
    updatedAt: share.updatedAt.toISOString(),
    publishedAt: share.publishedAt?.toISOString() ?? null,
    previews: share.previews.map((preview) => ({
      ...preview,
      url: previewApiUrl(preview.id),
    })),
  };
}

const shareInclude = {
  previews: { orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
};

export async function createInspirationShare(
  prisma: PrismaClient,
  input: {
    kind: InspirationShareKind;
    title: string;
    description?: string | null;
    authorName: string;
    tags: string[];
    fileName: string;
    payload: unknown;
    previews: PreviewInput[];
  },
) {
  const previews = validateInspirationSubmission(input);
  const shareId = randomUUID();
  const uploaded: Array<{
    id: string;
    objectKey: string;
    mimeType: string;
    width: number;
    height: number;
    sizeBytes: number;
    sortOrder: number;
  }> = [];
  try {
    for (const [sortOrder, preview] of previews.entries()) {
      const previewId = randomUUID();
      const objectKey = await uploadInspirationPreview({
        shareId,
        previewId,
        bytes: preview.bytes,
        mimeType: preview.mimeType,
      });
      uploaded.push({
        id: previewId,
        objectKey,
        mimeType: preview.mimeType,
        width: preview.width,
        height: preview.height,
        sizeBytes: preview.bytes.length,
        sortOrder,
      });
    }
    const share = await prisma.inspirationShare.create({
      data: {
        id: shareId,
        kind: input.kind,
        title: input.title,
        description: input.description ?? null,
        authorName: input.authorName,
        tags: input.tags,
        fileName: safeJsonFilename(input.fileName),
        jsonPayload: input.payload as Prisma.InputJsonValue,
        previews: { create: uploaded },
      },
      include: shareInclude,
    });
    return serializeShare(share);
  } catch (error) {
    await Promise.allSettled(uploaded.map((preview) => deleteInspirationPreview(preview.objectKey)));
    throw error;
  }
}

export async function listPublishedInspirationShares(
  prisma: PrismaClient,
  input: {
    kind?: InspirationShareKind | undefined;
    query?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const query = input.query?.trim();
  const items = await prisma.inspirationShare.findMany({
    where: {
      status: 'PUBLISHED',
      ...(input.kind ? { kind: input.kind } : {}),
      ...(query
        ? {
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
              { authorName: { contains: query, mode: 'insensitive' } },
              { tags: { has: query } },
            ],
          }
        : {}),
    },
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    include: shareInclude,
  });
  const hasMore = items.length > input.limit;
  const page = hasMore ? items.slice(0, input.limit) : items;
  return {
    items: page.map(serializeShare),
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
  };
}

export async function getPublishedInspirationShare(prisma: PrismaClient, shareId: string) {
  const share = await prisma.inspirationShare.findFirst({
    where: { id: shareId, status: 'PUBLISHED' },
    include: shareInclude,
  });
  return share ? serializeShare(share) : null;
}

export async function getInspirationShareDownload(prisma: PrismaClient, shareId: string) {
  return prisma.$transaction(async (transaction) => {
    const share = await transaction.inspirationShare.findFirst({
      where: { id: shareId, status: 'PUBLISHED' },
      select: { id: true, fileName: true, jsonPayload: true },
    });
    if (!share) return null;
    await transaction.inspirationShare.update({
      where: { id: share.id },
      data: { downloadCount: { increment: 1 } },
    });
    return share;
  });
}

export async function getInspirationPreviewRedirect(prisma: PrismaClient, previewId: string) {
  const preview = await prisma.inspirationSharePreview.findUnique({
    where: { id: previewId },
    select: { objectKey: true },
  });
  return preview ? getInspirationPreviewUrl(preview.objectKey) : null;
}

export async function listAdminInspirationShares(
  prisma: PrismaClient,
  input: { status?: InspirationShareStatus | undefined; limit: number },
) {
  const shares = await prisma.inspirationShare.findMany({
    ...(input.status ? { where: { status: input.status } } : {}),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit,
    include: shareInclude,
  });
  return { items: shares.map(serializeShare) };
}

export async function updateInspirationShareStatus(
  prisma: PrismaClient,
  shareId: string,
  status: InspirationShareStatus,
) {
  const share = await prisma.inspirationShare.update({
    where: { id: shareId },
    data: {
      status,
      publishedAt: status === 'PUBLISHED' ? new Date() : null,
    },
    include: shareInclude,
  });
  return serializeShare(share);
}

export async function deleteInspirationShare(prisma: PrismaClient, shareId: string) {
  const share = await prisma.inspirationShare.findUnique({
    where: { id: shareId },
    select: { previews: { select: { objectKey: true } } },
  });
  if (!share) return false;
  await prisma.inspirationShare.delete({ where: { id: shareId } });
  await Promise.allSettled(share.previews.map((preview) => deleteInspirationPreview(preview.objectKey)));
  return true;
}
