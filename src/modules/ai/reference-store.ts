import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';

const REFERENCE_TTL_MS = 20 * 60_000;
const MAX_REFERENCE_STORE_BYTES = 256 * 1024 * 1024;

type StoredImageReference = {
  bytes: Buffer;
  mime: string;
  expiresAt: number;
  createdAt: number;
};

const references = new Map<string, StoredImageReference>();
let storedBytes = 0;

function extensionForMime(mime: string) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}

function removeReference(key: string) {
  const existing = references.get(key);
  if (!existing) return;
  storedBytes -= existing.bytes.byteLength;
  references.delete(key);
}

export function pruneImageReferences(now = Date.now()) {
  for (const [key, value] of references) {
    if (value.expiresAt <= now) removeReference(key);
  }
  if (storedBytes <= MAX_REFERENCE_STORE_BYTES) return;
  const oldest = Array.from(references.entries()).sort((left, right) => left[1].createdAt - right[1].createdAt);
  for (const [key] of oldest) {
    removeReference(key);
    if (storedBytes <= MAX_REFERENCE_STORE_BYTES) break;
  }
}

export function createImageReference(bytes: Buffer, mime: string) {
  pruneImageReferences();
  const token = randomBytes(32).toString('hex');
  const extension = extensionForMime(mime);
  const key = `${token}.${extension}`;
  const now = Date.now();
  references.set(key, {
    bytes,
    mime,
    createdAt: now,
    expiresAt: now + REFERENCE_TTL_MS,
  });
  storedBytes += bytes.byteLength;
  pruneImageReferences();
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/v1/ai/references/${key}`;
}

export function getImageReference(key: string, now = Date.now()) {
  const value = references.get(key);
  if (!value) return null;
  if (value.expiresAt <= now) {
    removeReference(key);
    return null;
  }
  return value;
}
