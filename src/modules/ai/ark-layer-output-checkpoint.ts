import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { isPublicIp } from '../providers/url.js';
import type { LayerRoute } from './layer-canvas-config.js';

const version = 'v1';
const lifetimeMs = 9 * 60_000;
const maximumEncodedLength = 512 * 1024;
const ownHost = new URL(env.APP_BASE_URL).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');

type Identity = { requestId: string; userId: string };
type Limits = Pick<LayerRoute, 'maxLayers' | 'maxMegapixels'>;

function isExternalHttpsUrl(value: string) {
  if (!/^https:\/\/[^/]/.test(value) || !/^[!-~]+$/.test(value) || /["\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return host !== ownHost && !url.username && !url.password && !url.hash
      && host !== 'localhost' && host !== 'metadata.google.internal' && !/\.(?:local|localhost)$/.test(host)
      && (!isIP(host) || isPublicIp(host));
  } catch {
    return false;
  }
}

const dimension = z.number().int().min(1).max(8192);
const coordinate = z.number().int().min(-8192).max(8192);
const size = z.string().regex(/^\d{1,4}x\d{1,4}$/).refine(value =>
  value.split('x').every(part => dimension.safeParse(Number(part)).success));
const bounds = z.tuple([coordinate, coordinate, coordinate, coordinate]).refine(([left, top, right, bottom]) =>
  dimension.safeParse(right - left).success && dimension.safeParse(bottom - top).success);
const layer = z.object({
  url: z.string().max(4096).refine(isExternalHttpsUrl),
  size,
  z_index: z.number().int().nonnegative(),
  name: z.string().trim().transform(value => value.slice(0, 160) || undefined).optional(),
  bounding_box: z.object({ absolute: bounds }).optional(),
});
const payload = z.object({
  expiresAt: z.number().int().positive(),
  reply: z.object({ data: z.array(layer).min(2).max(65) }),
  limits: z.object({ maxLayers: z.number().int().min(1).max(64), maxMegapixels: z.number().int().min(1).max(64) }),
}).refine(({ reply: { data }, limits }) =>
  data.length <= limits.maxLayers + 1
  && new Set(data.map(item => item.z_index)).size === data.length
  && data.some(item => item.z_index === 0)
  && data.every(item => item.z_index === 0 || item.bounding_box !== undefined));

function encryptionKey() {
  const key = Buffer.from(env.PROVIDER_SECRETS_ENCRYPTION_KEY, 'base64');
  return key.length === 32 ? key : null;
}

function authenticatedIdentity({ userId, requestId }: Identity) {
  return Buffer.from(JSON.stringify(['ark-layer-output-checkpoint', version, userId, requestId]), 'utf8');
}

function decodeBase64Url(value: string) {
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

/** Save only the Ark output needed to retry downloads, bound to the owning request. */
export function sealArkLayerOutputCheckpoint(identity: Identity, reply: unknown, config: Limits, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) return null;
  const checked = payload.safeParse({ expiresAt: now + lifetimeMs, reply, limits: config });
  const key = encryptionKey();
  if (!checked.success || !key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(authenticatedIdentity(identity));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(checked.data), 'utf8'), cipher.final()]);
  const encoded = [version, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  return encoded.length <= maximumEncodedLength ? encoded : null;
}

/** An invalid, expired, or differently owned checkpoint cannot trigger a download. */
export function openArkLayerOutputCheckpoint(identity: Identity, encoded: string, now = Date.now()) {
  if (encoded.length > maximumEncodedLength || !Number.isSafeInteger(now) || now < 0) return null;
  const [sealedVersion, ivPart, tagPart, ciphertextPart, extra] = encoded.split('.', 5);
  if (sealedVersion !== version || !ivPart || !tagPart || !ciphertextPart || extra !== undefined) return null;
  const key = encryptionKey();
  const iv = decodeBase64Url(ivPart);
  const tag = decodeBase64Url(tagPart);
  const ciphertext = decodeBase64Url(ciphertextPart);
  if (!key || iv?.length !== 12 || tag?.length !== 16 || !ciphertext) return null;

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(authenticatedIdentity(identity));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const checked = payload.safeParse(JSON.parse(plaintext));
    if (!checked.success || checked.data.expiresAt <= now || checked.data.expiresAt > now + lifetimeMs) return null;
    return checked.data;
  } catch {
    return null;
  }
}
