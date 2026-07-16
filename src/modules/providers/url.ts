import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AiProviderKind } from '@prisma/client';

const endpointSuffix = /\/(?:v1\/(?:models|chat\/completions|responses|images\/(?:generations|edits)|video\/generations)|xais\/(?:userProfile|workerTaskStart|workerTaskWait|attUrls|fileAttachmentUploadUrl))\/?$/i;

function isPrivateIpv4(value: string) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

export function isPublicIp(value: string) {
  const version = isIP(value);
  if (version === 4) return !isPrivateIpv4(value);
  if (version !== 6) return false;
  const normalized = value.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPublicIp(normalized.slice('::ffff:'.length));
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('ff')
  );
}

export function normalizeProviderBaseUrl(
  kind: AiProviderKind,
  input: string,
  allowInsecureHttp = false,
) {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Provider Base URL is invalid');
  }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
    throw new Error('Provider Base URL must use HTTPS unless insecure HTTP is explicitly allowed');
  }
  if (url.username || url.password) throw new Error('Provider Base URL must not contain credentials');
  if (url.search || url.hash) throw new Error('Provider Base URL must not contain a query or fragment');
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    (isIP(hostname) !== 0 && !isPublicIp(hostname))
  ) {
    throw new Error('Provider Base URL must resolve to a public host');
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(endpointSuffix, '');
  if (/\/v1$/i.test(pathname)) pathname = pathname.slice(0, -3);
  url.pathname = pathname || '/';
  const normalized = url.toString().replace(/\/$/, '');
  if (kind === 'XAIS' && /\/xais$/i.test(normalized)) {
    return normalized.slice(0, -'/xais'.length);
  }
  return normalized;
}

export async function assertPublicProviderUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (isIP(url.hostname) !== 0) {
    if (!isPublicIp(url.hostname)) throw new Error('Provider host is not public');
    return;
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('Provider host did not resolve exclusively to public addresses');
  }
}

export function providerEndpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
