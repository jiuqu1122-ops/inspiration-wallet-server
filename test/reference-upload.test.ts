import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const storageMocks = vi.hoisted(() => ({
  createUploadUrl: vi.fn(() => ({
    url: 'https://inspirationdrawer-1475663212.cos.ap-singapore.myqcloud.com/reference-images/new.png?sign=temporary',
    method: 'PUT' as const,
    headers: { 'Content-Type': 'image/png' },
  })),
  headObject: vi.fn(async () => ({
    objectKey: 'reference-images/new.png',
    contentLength: 4,
    contentType: 'image/png',
    metadata: {},
    headers: {},
  })),
  getDownloadUrl: vi.fn((key: string) => `https://storage.example/${key}?signed=1`),
  tryResolveObjectKeyFromUrl: vi.fn(() => null as string | null),
  getObjectStream: vi.fn(async () => ({
    stream: Readable.from([Buffer.from('test')]),
    statusCode: 200,
    headers: { 'content-length': '4', 'content-type': 'image/png' },
  })),
}));

vi.mock('../src/modules/storage/service.js', () => ({ storageService: storageMocks }));

import {
  ReferenceUploadError,
  getReferenceImageContent,
  issueReferenceUploadTicket,
  proxyAgentChatReferenceImages,
  resolveReferenceImageSources,
  validateReferenceObjectKey,
} from '../src/modules/ai/reference-upload-service.js';

function fakePrisma() {
  return {
    referenceUpload: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'upload-1', ...data })),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
        id: 'upload-1',
        userId: 'user-1',
        objectKey: String(where.objectKey || 'reference-images/new.png'),
        contentType: 'image/png',
        sizeBytes: 4,
        status: 'ISSUED',
      })),
      update: vi.fn(async () => ({})),
    },
  };
}

describe('reference image direct upload ownership', () => {
  beforeEach(() => {
    storageMocks.createUploadUrl.mockClear();
    storageMocks.headObject.mockClear();
    storageMocks.getDownloadUrl.mockClear();
    storageMocks.tryResolveObjectKeyFromUrl.mockReset();
    storageMocks.tryResolveObjectKeyFromUrl.mockReturnValue(null);
    storageMocks.getObjectStream.mockClear();
  });

  it('issues a short-lived ticket for a server-generated reference object key', async () => {
    const prisma = fakePrisma();
    const ticket = await issueReferenceUploadTicket(prisma as never, 'user-1', {
      filename: 'anything.png',
      mime: 'image/png',
      sizeBytes: 4,
    });
    expect(ticket.objectKey).toMatch(/^reference-images\/[0-9a-f-]+\.png$/);
    expect(ticket.uploadUrl).toContain('myqcloud.com');
    expect(ticket.method).toBe('PUT');
    expect(ticket.expiresAt).toEqual(expect.any(String));
    expect(prisma.referenceUpload.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        objectKey: ticket.objectKey,
        contentType: 'image/png',
        sizeBytes: 4,
        status: 'ISSUED',
      }),
    });
  });

  it('validates ownership and HEAD metadata before resolving a direct key', async () => {
    const prisma = fakePrisma();
    await expect(resolveReferenceImageSources(
      prisma as never,
      'user-1',
      ['reference-images/new.png'],
    )).resolves.toEqual(['https://storage.example/reference-images/new.png?signed=1']);
    expect(storageMocks.headObject).toHaveBeenCalledWith('reference-images/new.png');
    expect(prisma.referenceUpload.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'upload-1' },
      data: expect.objectContaining({ status: 'UPLOADED' }),
    }));
  });

  it('rejects a direct key that is not owned by the current user', async () => {
    const prisma = fakePrisma();
    prisma.referenceUpload.findFirst.mockResolvedValueOnce(null);
    await expect(resolveReferenceImageSources(
      prisma as never,
      'other-user',
      ['reference-images/new.png'],
    )).rejects.toMatchObject({
      name: 'ReferenceUploadError',
      code: 'invalid_reference_image',
    } satisfies Partial<ReferenceUploadError>);
    expect(storageMocks.headObject).not.toHaveBeenCalled();
  });

  it('keeps strict historical own-storage URL compatibility without accepting arbitrary hosts', async () => {
    const prisma = fakePrisma();
    prisma.referenceUpload.findFirst.mockResolvedValueOnce(null);
    storageMocks.tryResolveObjectKeyFromUrl.mockReturnValueOnce('reference-images/history.png');
    storageMocks.headObject.mockResolvedValueOnce({
      objectKey: 'reference-images/history.png',
      contentLength: 4,
      contentType: 'image/png',
      metadata: {},
      headers: {},
    });
    await expect(resolveReferenceImageSources(
      prisma as never,
      'user-1',
      ['https://inspirationdrawer-1475663212.cos.ap-singapore.myqcloud.com/reference-images/history.png?sig=old'],
    )).resolves.toEqual(['https://storage.example/reference-images/history.png?signed=1']);
  });

  it('leaves own generated-media URLs on the existing storage-aware path', async () => {
    const prisma = fakePrisma();
    const generatedUrl = 'https://inspirationdrawer-1475663212.cos.ap-singapore.myqcloud.com/generated-images/result.png?sig=old';
    storageMocks.tryResolveObjectKeyFromUrl.mockReturnValueOnce('generated-images/result.png');

    await expect(resolveReferenceImageSources(
      prisma as never,
      'user-1',
      [generatedUrl],
    )).resolves.toEqual([generatedUrl]);
    expect(storageMocks.headObject).not.toHaveBeenCalled();
    expect(storageMocks.getDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects non-reference namespaces and path traversal before touching storage', () => {
    for (const value of [
      'generated-images/result.png',
      'reference-images/../secret.png',
      'reference-images\\secret.png',
      'reference-images/secret.png?download=1',
      'reference-images/',
    ]) {
      expect(() => validateReferenceObjectKey(value)).toThrow(ReferenceUploadError);
    }
  });

  it('rejects a missing uploaded object after ownership lookup', async () => {
    const prisma = fakePrisma();
    storageMocks.headObject.mockResolvedValueOnce(null);
    await expect(resolveReferenceImageSources(
      prisma as never,
      'user-1',
      ['reference-images/missing.png'],
    )).rejects.toMatchObject({
      name: 'ReferenceUploadError',
      code: 'reference_image_not_uploaded',
    });
    expect(storageMocks.headObject).toHaveBeenCalledWith('reference-images/missing.png');
    expect(storageMocks.getDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects an uploaded object whose HEAD metadata does not match the ticket', async () => {
    const prisma = fakePrisma();
    storageMocks.headObject.mockResolvedValueOnce({
      objectKey: 'reference-images/new.png',
      contentLength: 5,
      contentType: 'image/jpeg',
      metadata: {},
      headers: {},
    });
    await expect(resolveReferenceImageSources(
      prisma as never,
      'user-1',
      ['reference-images/new.png'],
    )).rejects.toMatchObject({
      name: 'ReferenceUploadError',
      code: 'reference_image_invalid',
    });
    expect(storageMocks.getDownloadUrl).not.toHaveBeenCalled();
  });

  it('rewrites owned chat image keys to the API proxy without exposing storage URLs', async () => {
    const prisma = fakePrisma();
    const externalUrl = 'https://images.example.org/reference.png';
    const objectKey = 'reference-images/12d2e7bb-6e3f-4ba0-bdb0-b82023a67e23.png';
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '分析图片' },
        { type: 'image_url', image_url: { url: objectKey, detail: 'low' } },
        { type: 'image_url', image_url: { url: externalUrl, detail: 'high' } },
      ],
    }];

    await expect(proxyAgentChatReferenceImages(
      prisma as never,
      'user-1',
      messages,
    )).resolves.toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '分析图片' },
        {
          type: 'image_url',
          image_url: {
            url: 'https://api.example.test/v1/ai/reference-images/content/12d2e7bb-6e3f-4ba0-bdb0-b82023a67e23.png',
            detail: 'low',
          },
        },
        { type: 'image_url', image_url: { url: externalUrl, detail: 'high' } },
      ],
    }]);
    expect(storageMocks.getDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects a chat image key owned by another user before calling the provider', async () => {
    const prisma = fakePrisma();
    prisma.referenceUpload.findFirst.mockResolvedValueOnce(null);
    await expect(proxyAgentChatReferenceImages(prisma as never, 'other-user', [{
      role: 'user',
      content: [{
        type: 'image_url',
        image_url: { url: 'reference-images/12d2e7bb-6e3f-4ba0-bdb0-b82023a67e23.png' },
      }],
    }])).rejects.toMatchObject({ code: 'invalid_reference_image' });
    expect(storageMocks.getDownloadUrl).not.toHaveBeenCalled();
  });

  it('opens only an unexpired recorded reference object for proxy streaming', async () => {
    const prisma = fakePrisma();
    const filename = '12d2e7bb-6e3f-4ba0-bdb0-b82023a67e23.png';
    storageMocks.getObjectStream.mockResolvedValueOnce({
      stream: Readable.from([Buffer.from('test')]),
      statusCode: 200,
      headers: { 'content-length': '4', 'content-type': 'image/png' },
    });
    const image = await getReferenceImageContent(prisma as never, filename);
    expect(image).toMatchObject({
      objectKey: `reference-images/${filename}`,
      contentType: 'image/png',
      contentLength: 4,
    });
    expect(storageMocks.getObjectStream).toHaveBeenCalledWith(`reference-images/${filename}`);

    prisma.referenceUpload.findFirst.mockResolvedValueOnce(null);
    await expect(getReferenceImageContent(prisma as never, filename))
      .rejects.toMatchObject({ code: 'reference_image_not_found', statusCode: 404 });
  });
});
