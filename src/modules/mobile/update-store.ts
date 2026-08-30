import { env } from '../../config/env.js';
import { storageService } from '../storage/service.js';

export type MobileUpdateObject = 'manifest' | 'apk';

const MOBILE_OBJECTS: Record<MobileUpdateObject, string> = {
  manifest: 'mobile/latest-mobile.json',
  apk: 'mobile/Inspiration-Drawer-Mobile-arm64.apk',
};

export function getMobileUpdateObjectKey(object: MobileUpdateObject) {
  return MOBILE_OBJECTS[object];
}

export function getMobileUpdateSignedUrl(object: MobileUpdateObject) {
  return storageService.getDownloadUrl(getMobileUpdateObjectKey(object));
}

export async function getMobileUpdateStream(object: MobileUpdateObject) {
  const response = await storageService.getObjectStream(getMobileUpdateObjectKey(object));
  return {
    stream: response.stream,
    res: {
      status: response.statusCode,
      headers: response.headers,
    },
  };
}

export async function getMobileUpdateManifest() {
  const response = await fetch(getMobileUpdateSignedUrl('manifest'), {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Mobile update manifest returned HTTP ${response.status}`);
  }
  const manifest = await response.json() as {
    apk?: Record<string, unknown>;
    [key: string]: unknown;
  };
  if (!manifest.apk || typeof manifest.apk !== 'object') {
    throw new Error('Mobile update manifest is missing APK metadata');
  }
  return {
    ...manifest,
    apk: {
      ...manifest.apk,
      url: `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/mobile/apk`,
    },
  };
}
