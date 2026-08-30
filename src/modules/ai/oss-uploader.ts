import { storageService, type StorageMediaNamespace } from '../storage/service.js';

export type OssMediaNamespace = StorageMediaNamespace;

const REFERENCE_URL_EXPIRES_SECONDS = 30 * 60;
const GENERATED_URL_EXPIRES_SECONDS = 24 * 60 * 60;

export const upload = storageService.uploadMedia.bind(storageService);
export const exists = storageService.exists.bind(storageService);
export const deleteObject = storageService.delete.bind(storageService);

export function getPublicUrl(objectKey: string, _options?: {
  mime?: string;
  filename?: string;
  download?: boolean;
}) {
  void _options;
  return storageService.getDownloadUrl(objectKey, {
    expiresSeconds: objectKey.startsWith('reference-images/')
      ? REFERENCE_URL_EXPIRES_SECONDS
      : GENERATED_URL_EXPIRES_SECONDS,
  });
}

export function verifyPublicImageUrl(objectKey: string, url: string) {
  return storageService.verifyImageUrl(objectKey, url);
}

/** Compatibility adapter retained while external callers migrate to storageService. */
export const ossUploadService = {
  upload,
  exists,
  getPublicUrl,
  verifyPublicImageUrl,
  delete: deleteObject,
};
