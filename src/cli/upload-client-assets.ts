import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import OSS from 'ali-oss';
import { CLIENT_ENGINE_ASSETS } from '../modules/ai/client-assets.js';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const requiredEnv = ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'] as const;
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const client = new OSS({
  region: process.env.OSS_REGION!,
  bucket: process.env.OSS_BUCKET!,
  accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
  secure: true,
});

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

async function uploadAssets(sourceDirectory: string, shouldDownload: boolean) {
  await mkdir(sourceDirectory, { recursive: true });
  for (const [name, asset] of Object.entries(CLIENT_ENGINE_ASSETS)) {
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

    const objectName = `client-assets/${name}`;
    process.stdout.write(`Uploading ${name} (${asset.size} bytes)... `);
    await client.put(objectName, path, {
      timeout: 10 * 60_000,
      headers: {
        'Content-Type': 'application/zip',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'x-oss-meta-sha256': asset.sha256,
      },
    });
    const head = await client.head(objectName, { timeout: 30_000 });
    const headers = head.res.headers as Record<string, string | string[] | number | undefined>;
    const rawRemoteSize = headers['content-length'];
    const remoteSize = Number(Array.isArray(rawRemoteSize) ? rawRemoteSize[0] : rawRemoteSize);
    if (Number.isFinite(remoteSize) && remoteSize !== asset.size) {
      throw new Error(`${name} OSS size mismatch: expected ${asset.size}, received ${remoteSize}`);
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
  process.stdout.write('All client engine assets are available in OSS.\n');
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
