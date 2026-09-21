import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

export const GENERATED_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_RESULT_KEY_PATTERN = /^[a-f0-9]{64}\.(?:png|jpe?g|webp|gif|avif)$/;
const MAX_RECEIPT_BYTES = 32 * 1024;
const MAX_SOURCE_URL_LENGTH = 12 * 1024;
const MAX_RECEIPTS = 10_000;

export class ImageDeliveryError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 503) {
    super(code);
    this.name = 'ImageDeliveryError';
  }
}

type FallbackReceipt = {
  version: 1;
  key: string;
  source: string;
  mime: string;
  createdAt: number;
  expiresAt: number;
};

export type FallbackStoreOptions = {
  directory: string;
  appBaseUrl: string;
  ttlMs: number;
  encryptionKey: () => Buffer;
  assertPublicUrl: (url: string) => Promise<unknown>;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  maxConcurrent?: number;
};

function mimeFromPrefix(bytes: Buffer) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0,6).toString())) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(4,8).toString() === 'ftyp' && /^(avif|avis)$/.test(bytes.subarray(8,12).toString())) return 'image/avif';
  return '';
}

function extensionForMime(mime: string) {
  const extension: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif',
  };
  const found = extension[mime];
  if (!found) throw new ImageDeliveryError('IMAGE_SOURCE_NOT_IMAGE', 502);
  return found;
}

/** Server-created, encrypted receipts. No API accepts a caller-supplied source URL.
 * The 256-bit opaque result key is a bearer capability, as with the existing
 * /image-results endpoint. Do not expose/list receipt files or log their URLs. */
export function createImageResultFallbackStore(options: FallbackStoreOptions) {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.appBaseUrl.replace(/\/+$/, '');
  const directory = join(options.directory, '.upstream-fallbacks');
  const ttlMs = Math.max(1, options.ttlMs);
  const maxBytes = options.maxBytes ?? GENERATED_IMAGE_MAX_BYTES;
  let activeRequests = 0;
  let lastPrunedAt = 0;
  let pendingPrune: Promise<void> | undefined;

  function resultUrl(key: string) {
    if (!IMAGE_RESULT_KEY_PATTERN.test(key)) throw new ImageDeliveryError('IMAGE_RESULT_NOT_FOUND', 404);
    return `${base}/v1/ai/image-results/${key}`;
  }

  function keyFromUrl(url: string) {
    const prefix = `${base}/v1/ai/image-results/`;
    const key = url.startsWith(prefix) ? url.slice(prefix.length) : '';
    if (!IMAGE_RESULT_KEY_PATTERN.test(key)) throw new ImageDeliveryError('IMAGE_RESULT_NOT_FOUND', 404);
    return key;
  }

  async function validateSource(source: string) {
    if (source.length > MAX_SOURCE_URL_LENGTH) throw new ImageDeliveryError('IMAGE_SOURCE_INVALID', 502);
    let url: URL;
    try { url = new URL(source); } catch { throw new ImageDeliveryError('IMAGE_SOURCE_INVALID', 502); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new ImageDeliveryError('IMAGE_SOURCE_INVALID', 502);
    }
    // Do not allow a receipt to point at our own delivery endpoint recursively.
    const own = new URL(base);
    if (url.origin === own.origin && url.pathname.includes('/v1/ai/image-results/')) {
      throw new ImageDeliveryError('IMAGE_SOURCE_RECURSIVE', 502);
    }
    await options.assertPublicUrl(url.toString());
    return url;
  }

  function secretKey() {
    const value = options.encryptionKey();
    if (value.length !== 32) throw new ImageDeliveryError('IMAGE_FALLBACK_ENCRYPTION_NOT_CONFIGURED');
    return value;
  }

  function encrypt(receipt: FallbackReceipt) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
    cipher.setAAD(Buffer.from(`image-result-fallback:v1:${receipt.key}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(receipt), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  }

  function decrypt(key: string, value: string): FallbackReceipt {
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new ImageDeliveryError('IMAGE_FALLBACK_INVALID', 410);
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(parts[1]!, 'base64url'));
    decipher.setAAD(Buffer.from(`image-result-fallback:v1:${key}`));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    const decoded = Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]);
    const valueObject = JSON.parse(decoded.toString('utf8')) as FallbackReceipt;
    if (valueObject.version !== 1 || valueObject.key !== key
      || typeof valueObject.source !== 'string' || typeof valueObject.mime !== 'string'
      || !Number.isFinite(valueObject.expiresAt) || !Number.isFinite(valueObject.createdAt)) {
      throw new ImageDeliveryError('IMAGE_FALLBACK_INVALID', 410);
    }
    extensionForMime(valueObject.mime);
    return valueObject;
  }

  async function prune() {
    if (pendingPrune) return pendingPrune;
    if (lastPrunedAt && now() - lastPrunedAt < 60_000) return;
    pendingPrune = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const files = await readdir(directory, { withFileTypes: true });
      for (const entry of files) {
        if (!entry.isFile()) continue;
        const pending = /^\.pending-/.test(entry.name);
        if (!pending && !IMAGE_RESULT_KEY_PATTERN.test(entry.name.replace(/\.enc$/, ''))) continue;
        const path = join(directory, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs + (pending ? 10 * 60_000 : ttlMs) <= now()) await rm(path, { force: true });
      }
      lastPrunedAt = now();
    })().finally(() => { pendingPrune = undefined; });
    return pendingPrune;
  }

  async function rememberVerifiedSource(source: string, mime: string, stableUrl?: string) {
    await validateSource(source);
    const key = stableUrl ? keyFromUrl(stableUrl) : `${randomBytes(32).toString('hex')}.${extensionForMime(mime)}`;
    extensionForMime(mime);
    await prune();
    const destination = join(directory, `${key}.enc`);
    // Prevent receipt growth from being unbounded during a storage outage.
    if (!await stat(destination).catch(() => null)) {
      const count = (await readdir(directory)).filter(name => name.endsWith('.enc')).length;
      if (count >= MAX_RECEIPTS) throw new ImageDeliveryError('IMAGE_FALLBACK_CAPACITY');
    }
    const receipt: FallbackReceipt = { version: 1, key, source, mime, createdAt: now(), expiresAt: now() + ttlMs };
    const ciphertext = encrypt(receipt);
    const temporary = join(directory, `.pending-${randomBytes(16).toString('hex')}`);
    try {
      await writeFile(temporary, ciphertext, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return resultUrl(key);
  }

  async function getReceipt(key: string): Promise<FallbackReceipt | null> {
    if (!IMAGE_RESULT_KEY_PATTERN.test(key)) return null;
    const path = join(directory, `${key}.enc`);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > MAX_RECEIPT_BYTES) return null;
    const receipt = decrypt(key, await readFile(path, 'utf8'));
    if (receipt.expiresAt <= now()) {
      await rm(path, { force: true });
      return null;
    }
    return receipt;
  }

  /** Does not attach API credentials/cookies. Validates every redirect and the
   * image's signature bytes before exposing a stream. Streaming remains bounded. */
  async function openSource(source: string, probe = false) {
    if (activeRequests >= (options.maxConcurrent ?? 8)) throw new ImageDeliveryError('IMAGE_FALLBACK_BUSY', 429);
    activeRequests += 1;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let closed = false;
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      activeRequests -= 1;
    };
    try {
      let current = source;
      let response: Response | undefined;
      for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
        const safe = await validateSource(current);
        response = await fetcher(safe, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { accept: 'image/*', ...(probe ? { range: 'bytes=0-63' } : {}) },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (response.body) void response.body.cancel().catch(() => {});
          if (!location || redirectCount === 3) throw new ImageDeliveryError('IMAGE_SOURCE_REDIRECT_INVALID', 502);
          current = new URL(location, safe).toString();
          continue;
        }
        break;
      }
      if (!response || (probe ? ![200, 206].includes(response.status) : response.status !== 200)) {
        if (response?.body) void response.body.cancel().catch(() => {});
        const status = response?.status;
        throw new ImageDeliveryError(
          status === 401 || status === 403 || status === 404 || status === 410
            ? 'IMAGE_SOURCE_EXPIRED_OR_UNAVAILABLE' : 'IMAGE_SOURCE_HTTP_ERROR',
          status === 401 || status === 403 || status === 404 || status === 410 ? 410 : 503,
        );
      }
      const lengthHeader = response.headers.get('content-length');
      const length = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
      const rangeTotal = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
      if ((length !== undefined && length > maxBytes) || (rangeTotal && Number(rangeTotal) > maxBytes)) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new ImageDeliveryError('GENERATED_IMAGE_TOO_LARGE', 413);
      }
      if (!response.body) throw new ImageDeliveryError('IMAGE_SOURCE_EMPTY', 502);
      reader = response.body.getReader();
      const initial: Uint8Array[] = [];
      let initialSize = 0;
      while (initialSize < 32) {
        const chunk = await reader.read();
        if (chunk.done) break;
        initial.push(chunk.value);
        initialSize += chunk.value.byteLength;
        if (initialSize > maxBytes) throw new ImageDeliveryError('GENERATED_IMAGE_TOO_LARGE', 413);
      }
      const prefix = Buffer.concat(initial.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), initialSize).subarray(0,32);
      const mime = mimeFromPrefix(prefix);
      if (!mime) throw new ImageDeliveryError('IMAGE_SOURCE_NOT_IMAGE', 502);
      const encoding = response.headers.get('content-encoding');
      const checkLength = !encoding || encoding === 'identity';
      const contentLength = checkLength ? length : undefined;
      const read = reader;
      const body = Readable.from((async function* () {
        let total = initialSize;
        try {
          for (const chunk of initial) yield chunk;
          while (true) {
            const chunk = await read.read();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > maxBytes) throw new ImageDeliveryError('GENERATED_IMAGE_TOO_LARGE', 413);
            yield chunk.value;
          }
          if (checkLength && length !== undefined && total !== length) {
            throw new ImageDeliveryError('IMAGE_SOURCE_LENGTH_MISMATCH', 502);
          }
        } finally { close(); }
      })());
      body.once('close', close);
      return { mime, contentLength, body, close };
    } catch (error) { close(); throw error; }
  }

  async function createFallback(source: string) {
    // A task/status/result URL or HTTP 202 JSON is NOT a completed image.
    // Require an independently readable image response before returning success.
    const probe = await openSource(source, true);
    try { return await rememberVerifiedSource(source, probe.mime); }
    finally { probe.body.destroy(); probe.close(); }
  }

  return { resultUrl, keyFromUrl, rememberVerifiedSource, getReceipt, openSource, createFallback };
}
