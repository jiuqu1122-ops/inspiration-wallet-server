import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CLIENT_ENGINE_ASSETS } from '../modules/ai/client-assets.js';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { storageService } = await import('../modules/storage/service.js');

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex').toUpperCase();
}

async function download(url: string, path: string) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'inspiration-wallet-server-client-asset-uploader/1.0' },
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`asset download failed with HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(path, { flags: 'wx' }),
  );
}

async function remoteAssetIsCurrent(objectName: string, size: number, sha256: string) {
  const head = await storageService.headObject(objectName);
  return head?.contentLength === size && head.metadata.sha256?.toUpperCase() === sha256;
}

async function uploadAssets(sourceDirectory: string, shouldDownload: boolean) {
  await mkdir(sourceDirectory, { recursive: true });
  for (const [name, asset] of Object.entries(CLIENT_ENGINE_ASSETS)) {
    const objectName = `client-assets/${name}`;
    if (await remoteAssetIsCurrent(objectName, asset.size, asset.sha256)) {
      process.stdout.write(`${name} is already verified in ${storageService.providerName}.\n`);
      continue;
    }

    const path = resolve(sourceDirectory, basename(name));
    if (shouldDownload) {
      process.stdout.write(`Downloading ${name}... `);
      await download(asset.sourceUrl, path);
      process.stdout.write('done\n');
    }

    const info = await stat(path);
    if (!info.isFile() || info.size !== asset.size) {
      throw new Error(`${name} size mismatch: expected ${asset.size}, received ${info.size}`);
    }
    const digest = await sha256(path);
    if (digest !== asset.sha256) {
      throw new Error(`${name} SHA-256 mismatch: expected ${asset.sha256}, received ${digest}`);
    }

    process.stdout.write(`Uploading ${name} (${asset.size} bytes)... `);
    await storageService.upload({
      objectKey: objectName,
      source: path,
      contentType: 'application/zip',
      cacheControl: 'private, max-age=31536000, immutable',
      metadata: { sha256: asset.sha256 },
      timeoutMs: 10 * 60_000,
    });
    if (!await remoteAssetIsCurrent(objectName, asset.size, asset.sha256)) {
      throw new Error(`${name} object storage verification failed after upload`);
    }
    process.stdout.write('verified\n');
  }
}

const shouldDownload = process.argv[2] === '--download';
const temporaryDirectory = shouldDownload
  ? await mkdtemp(join(tmpdir(), 'inspiration-client-assets-'))
  : null;
const sourceDirectory = temporaryDirectory ?? resolve(process.argv[2] || 'client-assets');

try {
  await uploadAssets(sourceDirectory, shouldDownload);
  process.stdout.write(`All client engine assets are available in ${storageService.providerName}.\n`);
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
