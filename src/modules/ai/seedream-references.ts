import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { Agent } from 'undici';
import sharp from 'sharp';
import { isPublicIp } from '../providers/url.js';
import { storageService } from '../storage/service.js';
import { getImageResult, isStoredImageResultUrl } from './image-result-store.js';
import {
  createProviderReference, getProviderReference, providerReferenceKey, removeProviderReference,
} from './provider-reference-store.js';
import { REFERENCE_UPLOAD_MAX_BYTES, ReferenceUploadError } from './reference-upload-service.js';

export type ReferenceSourceType = 'local' | 'cos' | 'signed_url' | 'public_url' | 'data_url';
export type ReferenceTransport = 'data_url' | 'public_https';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const imageMime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const;

export function referenceSourceType(source: string): ReferenceSourceType {
  const value = source.trim();
  if (/^data:/i.test(value)) return 'data_url';
  if (!/^https?:\/\//i.test(value)) return 'local';
  try {
    const url = new URL(value);
    if (/(?:^|\.)cos(?:\.[a-z0-9-]+)?\.myqcloud\.com$/i.test(url.hostname)) return 'cos';
    if (Array.from(url.searchParams.keys()).some(key => /(?:sign|token|expires|credential)/i.test(key))) {
      return 'signed_url';
    }
  } catch { /* Invalid sources are rejected by the reader without logging them. */ }
  return 'public_url';
}

function publicReferenceUrl(source: string) {
  let url: URL;
  try { url = new URL(source); } catch { throw new ReferenceUploadError('Reference image URL is invalid'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname === 'metadata.google.internal'
    || (isIP(hostname) && !publicReferenceIp(hostname))) {
    throw new ReferenceUploadError('Reference image requires a public HTTPS address', 'reference_image_url_blocked');
  }
  return url;
}

function publicReferenceIp(address: string) {
  if (!isPublicIp(address)) return false;
  // Reject IPv6 transition/compatible addresses as well as non-global scopes.
  return isIP(address) !== 6 || (/^[23]/i.test(address)
    && !/^2002:|^2001:0(?:000)?:/i.test(address));
}

async function validatedImage(bytes: Buffer, declaredMime = '', maximumBytes = REFERENCE_UPLOAD_MAX_BYTES) {
  if (!bytes.length || bytes.length > maximumBytes) {
    throw new ReferenceUploadError(`Reference image size must be between 1 byte and ${maximumBytes / 1024 / 1024} MiB`);
  }
  const headerMime = declaredMime.split(';')[0]!.trim().toLowerCase();
  let mime: string;
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 8192 * 8192 }).timeout({ seconds: 10 });
    const metadata = await image.metadata();
    mime = imageMime[metadata.format as keyof typeof imageMime];
    if (!mime || !metadata.width || !metadata.height) throw new Error('unsupported format');
    // Metadata alone accepts truncated files. Decode before submitting any task.
    await image.stats();
  } catch {
    throw new ReferenceUploadError('Reference image bytes are invalid or use an unsupported format');
  }
  if (headerMime && headerMime !== 'application/octet-stream'
    && headerMime !== mime && !(headerMime === 'image/jpg' && mime === 'image/jpeg')) {
    throw new ReferenceUploadError('Reference image MIME type does not match its content');
  }
  return { bytes, mime };
}

async function readImageResponse(response: Response, maximumBytes = REFERENCE_UPLOAD_MAX_BYTES) {
  const length = Number(response.headers.get('content-length') || 0);
  if (!response.body) throw new ReferenceUploadError('Reference image response is empty');
  const reader = response.body.getReader();
  let complete = false;
  try {
    if (length > maximumBytes) throw new ReferenceUploadError(`Reference image exceeds ${maximumBytes / 1024 / 1024} MiB`);
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new ReferenceUploadError(`Reference image exceeds ${maximumBytes / 1024 / 1024} MiB`);
      chunks.push(Buffer.from(value));
    }
    complete = true;
    if (length > 0 && !response.headers.get('content-encoding') && length !== size) {
      throw new ReferenceUploadError('Reference image download was incomplete');
    }
    return validatedImage(Buffer.concat(chunks), response.headers.get('content-type') || '', maximumBytes);
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function fetchPublicReference(source: string, signal: AbortSignal, maximumBytes = REFERENCE_UPLOAD_MAX_BYTES) {
  let current = publicReferenceUrl(source);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const hostname = current.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !publicReferenceIp(address))) {
      throw new ReferenceUploadError('Reference host must resolve only to public addresses', 'reference_image_url_blocked');
    }
    // Pin the already checked DNS answer for the socket; a second DNS lookup
    // must not allow rebinding between validation and connection.
    const dispatcher = new Agent({ connect: { lookup: (_host, options, callback) => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    } } });
    try {
      const response = await fetch(current, {
        method: 'GET', headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
        redirect: 'manual', signal, dispatcher,
      } as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location || redirects === MAX_REDIRECTS) throw new ReferenceUploadError('Reference image redirect is invalid');
        try { current = publicReferenceUrl(new URL(location, current).toString()); }
        catch { throw new ReferenceUploadError('Reference image redirect is blocked', 'reference_image_url_blocked'); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ReferenceUploadError(`Reference image download returned HTTP ${response.status}`);
      }
      return await readImageResponse(response, maximumBytes);
    } finally {
      await dispatcher.destroy();
    }
  }
  throw new ReferenceUploadError('Reference image redirect limit exceeded');
}

async function readReference(source: string, signal: AbortSignal, maximumBytes = REFERENCE_UPLOAD_MAX_BYTES) {
  const value = source.trim();
  if (/^data:/i.test(value)) {
    const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(value);
    if (!match) throw new ReferenceUploadError('Reference image Data URL is invalid');
    const base64 = match[2]!.replace(/\s/g, '');
    if (base64.length > Math.ceil(maximumBytes / 3) * 4) {
      throw new ReferenceUploadError(`Reference image exceeds ${maximumBytes / 1024 / 1024} MiB`);
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64) throw new ReferenceUploadError('Reference image base64 is invalid');
    return validatedImage(bytes, match[1], maximumBytes);
  }
  const url = publicReferenceUrl(value);
  const cachedKey = providerReferenceKey(value);
  const cached = cachedKey ? await getProviderReference(cachedKey)
    : isStoredImageResultUrl(value) ? await getImageResult(url.pathname.split('/').at(-1)!) : null;
  if (cachedKey || isStoredImageResultUrl(value)) {
    if (!cached) throw new ReferenceUploadError('Cached reference image is missing or expired');
    if (cached.size > maximumBytes) throw new ReferenceUploadError(`Reference image exceeds ${maximumBytes / 1024 / 1024} MiB`);
    return validatedImage(await readFile(cached.path), cached.mime, maximumBytes);
  }
  const objectKey = storageService.tryResolveObjectKeyFromUrl(value);
  if (objectKey) {
    // Source ownership was checked by resolveReferenceImageSources. This uses
    // the configured Storage SDK endpoint, never an arbitrary URL or user path.
    const stored = await storageService.getObjectStream(objectKey);
    const abort = () => { stored.stream.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      if (stored.statusCode < 200 || stored.statusCode >= 300) throw new ReferenceUploadError('Stored reference image is unavailable');
      const headers = new Headers();
      for (const name of ['content-type', 'content-length']) {
        const entry = Object.entries(stored.headers).find(([key]) => key.toLowerCase() === name)?.[1];
        if (typeof entry === 'string' || typeof entry === 'number') headers.set(name, String(entry));
      }
      return await readImageResponse(new Response(Readable.toWeb(stored.stream) as BodyInit, { headers }), maximumBytes);
    } finally {
      signal.removeEventListener('abort', abort);
      stored.stream.destroy();
    }
  }
  return fetchPublicReference(value, signal, maximumBytes);
}

async function prepareReference(
  source: string,
  transport: ReferenceTransport,
  maximumBytes = REFERENCE_UPLOAD_MAX_BYTES,
  pngJpegOnly = false,
) {
  const controller = new AbortController();
  let temporaryUrl: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    let image = await readReference(source, controller.signal, maximumBytes);
    if (pngJpegOnly && image.mime === 'image/webp') {
      const png = await sharp(image.bytes, { failOn: 'warning', limitInputPixels: 8192 * 8192 })
        .timeout({ seconds: 10 }).png().toBuffer();
      image = await validatedImage(png, 'image/png', maximumBytes);
    }
    if (pngJpegOnly && image.mime !== 'image/png' && image.mime !== 'image/jpeg') {
      throw new ReferenceUploadError('参考图仅支持 PNG/JPEG 或可转换为 PNG 的 WebP 图片，请转换图片格式后重试。');
    }
    controller.signal.throwIfAborted();
    if (transport === 'data_url') {
      return { value: `data:${image.mime};base64,${image.bytes.toString('base64')}`, mime: image.mime, sizeBytes: image.bytes.length };
    }
    temporaryUrl = await createProviderReference(image.bytes, image.mime);
    try {
      // Check the actual anonymous public route, including every redirect.
      const served = await fetchPublicReference(temporaryUrl, controller.signal, maximumBytes);
      if (!served.bytes.equals(image.bytes)) throw new ReferenceUploadError('Temporary reference content did not match');
      return { value: temporaryUrl, mime: image.mime, sizeBytes: image.bytes.length };
    } catch (error) {
      await removeProviderReference(temporaryUrl);
      throw error;
    }
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ReferenceUploadError('Reference image preparation timed out', 'reference_image_timeout', 504));
      }, FETCH_TIMEOUT_MS);
    })]);
  } catch (error) {
    if (temporaryUrl) await removeProviderReference(temporaryUrl);
    if (error instanceof ReferenceUploadError) throw error;
    // SDK, DNS, fetch and decoder errors may contain URLs or local paths.
    throw new ReferenceUploadError('Reference image could not be read or validated');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function prepareSeedreamReference(source: string, transport: ReferenceTransport) {
  return prepareReference(source, transport);
}

/** Explicit Generic Data URL routes use their own limits and image contract;
 * existing readers retain the original 10 MiB and format behavior. */
export function prepareGenericImageDataUrlReference(source: string) {
  return prepareReference(source, 'data_url', 20 * 1024 * 1024, true);
}
