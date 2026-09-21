import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createImageResultFallbackStore,
  GENERATED_IMAGE_MAX_BYTES,
  ImageDeliveryError,
  type FallbackStoreOptions,
} from '../src/modules/ai/image-result-fallback-core.js';

const MiB = 1024 * 1024;
const pngHeader = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1,
  8, 6, 0, 0, 0, 0, 0, 0,
]);
const source = 'https://images.example.test/result.png?signature=NEVER_EXPOSE_THIS';
const cleanupDirectories: string[] = [];

function pngBytes(size = 64) {
  const bytes = Buffer.alloc(size, 0);
  pngHeader.copy(bytes);
  return bytes;
}

async function harness(
  fetcher: typeof fetch,
  extras: Partial<FallbackStoreOptions> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'image-fallback-core-'));
  cleanupDirectories.push(directory);
  const options: FallbackStoreOptions = {
    directory,
    appBaseUrl: 'https://api.example.test',
    ttlMs: 60_000,
    encryptionKey: () => Buffer.alloc(32, 7),
    assertPublicUrl: async () => {},
    fetcher,
    ...extras,
  };
  return { directory, options, store: createImageResultFallbackStore(options) };
}

async function drain(body: NodeJS.ReadableStream) {
  let bytes = 0;
  for await (const chunk of body) bytes += Buffer.byteLength(chunk);
  return bytes;
}

function generatedResponse(size: number, withLength = true) {
  let sent = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const count = Math.min(256 * 1024, size - sent);
      const bytes = sent === 0 ? pngBytes(count) : new Uint8Array(count);
      sent += count;
      controller.enqueue(bytes);
    },
  }), {
    headers: {
      'content-type': 'image/png',
      ...(withLength ? { 'content-length': String(size) } : {}),
    },
  });
}

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('image result upstream fallback store', () => {
  it('streams a 20 MiB result without the reference-image 16 MiB ceiling', async () => {
    const { store } = await harness((async () => generatedResponse(20 * MiB)) as typeof fetch);
    const image = await store.openSource(source);
    expect(image.contentLength).toBe(20 * MiB);
    expect(await drain(image.body)).toBe(20 * MiB);
  });

  it('accepts exactly 64 MiB and rejects a declared byte over the limit', async () => {
    expect(GENERATED_IMAGE_MAX_BYTES).toBe(64 * MiB);
    const { store } = await harness((async () => generatedResponse(64 * MiB)) as typeof fetch);
    expect(await drain((await store.openSource(source)).body)).toBe(64 * MiB);

    const oversized = await harness((async () => generatedResponse(64 * MiB + 1)) as typeof fetch);
    await expect(oversized.store.openSource(source)).rejects.toMatchObject({
      code: 'GENERATED_IMAGE_TOO_LARGE',
      statusCode: 413,
    });
  });

  it('bounds an unknown-length stream by bytes actually read', async () => {
    const { store } = await harness((async () => generatedResponse(20 * MiB, false)) as typeof fetch);
    expect(await drain((await store.openSource(source)).body)).toBe(20 * MiB);

    const oversized = await harness(
      (async () => generatedResponse(2049, false)) as typeof fetch,
      { maxBytes: 2048 },
    );
    await expect((async () => {
      const image = await oversized.store.openSource(source);
      return drain(image.body);
    })()).rejects.toMatchObject({
      code: 'GENERATED_IMAGE_TOO_LARGE',
    });
  });

  it('encrypts the upstream URL receipt and can read it after store recreation', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fallback = await harness((async (_url: URL | RequestInfo, init?: RequestInit) => {
      calls.push(init);
      return new Response(pngBytes(), {
        status: 206,
        headers: { 'content-range': `bytes 0-63/${20 * MiB}`, 'content-length': '64' },
      });
    }) as typeof fetch);

    const stableUrl = await fallback.store.createFallback(source);
    const key = fallback.store.keyFromUrl(stableUrl);
    expect(stableUrl).toMatch(/^https:\/\/api\.example\.test\/v1\/ai\/image-results\/[a-f0-9]{64}\.png$/);
    expect(stableUrl).not.toContain('signature');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect((calls[0]?.headers as Record<string, string>).range).toBe('bytes=0-63');
    expect((calls[0]?.headers as Record<string, string>).authorization).toBeUndefined();

    const encrypted = await readFile(
      join(fallback.directory, '.upstream-fallbacks', `${key}.enc`),
      'utf8',
    );
    expect(encrypted).not.toContain('signature');
    expect(encrypted).not.toContain('images.example');

    const restarted = createImageResultFallbackStore(fallback.options);
    expect(await restarted.getReceipt(key)).toMatchObject({ source, key, mime: 'image/png' });
  });

  it('does not register JSON, HTTP 202, or HTML as a completed image', async () => {
    for (const response of [
      new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } }),
      new Response('<html>not an image</html>', { headers: { 'content-type': 'image/png' } }),
    ]) {
      const { store, directory } = await harness((async () => response) as typeof fetch);
      await expect(store.createFallback(source)).rejects.toBeInstanceOf(Error);
      expect(await readdir(join(directory, '.upstream-fallbacks')).catch(() => [])).toHaveLength(0);
    }
  });

  it('uses Content-Range totals to reject oversized results during the probe', async () => {
    const { store } = await harness((async () => new Response(pngBytes(), {
      status: 206,
      headers: { 'content-range': `bytes 0-63/${65 * MiB}` },
    })) as typeof fetch);
    await expect(store.createFallback(source)).rejects.toMatchObject({ code: 'GENERATED_IMAGE_TOO_LARGE' });
  });

  it('rejects expired, tampered, and traversal receipt keys', async () => {
    let now = Date.now();
    const fallback = await harness(
      (async () => new Response(pngBytes())) as typeof fetch,
      { now: () => now, ttlMs: 100 },
    );
    const stableUrl = await fallback.store.createFallback(source);
    const key = fallback.store.keyFromUrl(stableUrl);
    expect(await fallback.store.getReceipt('../../secret')).toBeNull();

    const encrypted = await readFile(join(fallback.directory, '.upstream-fallbacks', `${key}.enc`));
    const otherKey = `${'c'.repeat(64)}.png`;
    await writeFile(join(fallback.directory, '.upstream-fallbacks', `${otherKey}.enc`), encrypted);
    await expect(fallback.store.getReceipt(otherKey)).rejects.toBeInstanceOf(Error);

    now += 101;
    expect(await fallback.store.getReceipt(key)).toBeNull();
  });

  it.each([401, 403, 404, 410])('maps an expired upstream HTTP %s response to 410', async (status) => {
    let calls = 0;
    const { store } = await harness((async () => {
      calls += 1;
      return new Response('', { status });
    }) as typeof fetch);
    await expect(store.createFallback(source)).rejects.toMatchObject({
      code: 'IMAGE_SOURCE_EXPIRED_OR_UNAVAILABLE',
      statusCode: 410,
    });
    expect(calls).toBe(1);
  });

  it('validates every redirect and sends no credentials to the source', async () => {
    const seen: string[] = [];
    const { store } = await harness(
      (async (_url: URL | RequestInfo, init?: RequestInit) => {
        expect(init?.credentials).toBeUndefined();
        expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
      }) as typeof fetch,
      {
        assertPublicUrl: async (url) => {
          seen.push(url);
          if (new URL(url).hostname === '127.0.0.1') throw new ImageDeliveryError('PRIVATE_URL');
        },
      },
    );
    await expect(store.createFallback(source)).rejects.toMatchObject({ code: 'PRIVATE_URL' });
    expect(seen).toHaveLength(2);
  });

  it('rejects recursive bridge URLs before making a request', async () => {
    let calls = 0;
    const { store } = await harness((async () => {
      calls += 1;
      return new Response(pngBytes());
    }) as typeof fetch);
    await expect(store.createFallback(
      `https://api.example.test/v1/ai/image-results/${'a'.repeat(64)}.png`,
    )).rejects.toMatchObject({ code: 'IMAGE_SOURCE_RECURSIVE' });
    expect(calls).toBe(0);
  });

  it('releases the concurrency slot after a reader is closed', async () => {
    const { store } = await harness(
      (async () => new Response(pngBytes())) as typeof fetch,
      { maxConcurrent: 1 },
    );
    const first = await store.openSource(source);
    await expect(store.openSource(source)).rejects.toMatchObject({ code: 'IMAGE_FALLBACK_BUSY' });
    first.body.destroy();
    first.close();
    expect(await drain((await store.openSource(source)).body)).toBe(64);
  });

  it('rejects a declared content-length mismatch', async () => {
    const { store } = await harness((async () => new Response(pngBytes(), {
      headers: { 'content-length': '1000' },
    })) as typeof fetch);
    await expect(drain((await store.openSource(source)).body)).rejects.toMatchObject({
      code: 'IMAGE_SOURCE_LENGTH_MISMATCH',
    });
  });

  it('streams a real 20 MiB HTTP response and aborts a stalled response', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/stall') {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.write(pngBytes());
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(20 * MiB),
      });
      let bytes = 0;
      const write = () => {
        while (bytes < 20 * MiB) {
          const count = Math.min(256 * 1024, 20 * MiB - bytes);
          const part = bytes === 0 ? pngBytes(count) : Buffer.alloc(count);
          bytes += part.length;
          if (!response.write(part)) {
            response.once('drain', write);
            return;
          }
        }
        response.end();
      };
      write();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const { store } = await harness(fetch, { timeoutMs: 250 });
      expect(await drain((await store.openSource(`${baseUrl}/image`)).body)).toBe(20 * MiB);
      await expect(drain((await store.openSource(`${baseUrl}/stall`)).body)).rejects.toBeInstanceOf(Error);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });
});
