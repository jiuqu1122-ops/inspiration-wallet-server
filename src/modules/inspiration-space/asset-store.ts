import { storageService } from '../storage/service.js';

const SAFE_ID = /^[a-zA-Z0-9-]{16,80}$/;
const SAFE_OBJECT_KEY = /^inspiration-space\/[a-zA-Z0-9-]{16,80}\/previews\/[a-zA-Z0-9-]{16,80}\.(?:jpg|png|webp)$/;

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
  const result = await storageService.upload({
    objectKey,
    source: input.bytes,
    contentType: input.mimeType,
    cacheControl: 'private, max-age=21600, immutable',
  });
  if (result.objectKey !== objectKey) {
    throw new Error('Object storage returned an unexpected inspiration space object key');
  }
  return objectKey;
}

export function getInspirationPreviewUrl(objectKey: string) {
  return storageService.getDownloadUrl(validateObjectKey(objectKey));
}

export function deleteInspirationPreview(objectKey: string) {
  return storageService.delete(validateObjectKey(objectKey));
}
