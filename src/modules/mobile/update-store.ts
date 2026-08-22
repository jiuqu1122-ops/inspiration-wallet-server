import OSS from 'ali-oss';
import { env } from '../../config/env.js';

export type MobileUpdateObject = 'manifest' | 'apk';

const MOBILE_OBJECTS: Record<MobileUpdateObject, string> = {
  manifest: 'mobile/latest-mobile.json',
  apk: 'mobile/Inspiration-Drawer-Mobile-arm64.apk',
};

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
  if (!client) throw new Error('Aliyun OSS is not configured for mobile updates');
  return client;
}

export function getMobileUpdateObjectKey(object: MobileUpdateObject) {
  return MOBILE_OBJECTS[object];
}

export function getMobileUpdateSignedUrl(object: MobileUpdateObject) {
  return requireClient().signatureUrl(getMobileUpdateObjectKey(object), {
    expires: object === 'apk' ? 60 * 60 : 10 * 60,
  });
}

export async function getMobileUpdateStream(object: MobileUpdateObject) {
  const response = await requireClient().getStream(getMobileUpdateObjectKey(object), {
    timeout: object === 'apk' ? 10 * 60_000 : 30_000,
  });
  if (response.res.status !== 200 || !response.stream) {
    throw new Error(`Mobile update object returned HTTP ${response.res.status}`);
  }
  return response;
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
