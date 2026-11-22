import '../setup-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sharp from 'sharp';
import type { AiProviderChannel, PrismaClient } from '@prisma/client';

export async function startLayerMock(port = 4137) {
  const appAddress = 'http://127.0.0.1:' + port;
  process.env.APP_BASE_URL = appAddress;
  process.env.IMAGE_RESULT_STORE_DIR = await mkdtemp(join(tmpdir(), 'drawer-layer-test-'));
  const { aiRoutes } = await import('../../src/modules/ai/routes.js');
  const { aiModelAdminRoutes } = await import('../../src/modules/ai/model-admin-routes.js');
  const { providerAdminRoutes } = await import('../../src/modules/providers/routes.js');
  const { encryptProviderSecrets } = await import('../../src/lib/provider-secrets.js');
  const { creditDecimal } = await import('../../src/modules/wallets/credit-amount.js');
  const { createImageResultFromResponse } = await import('../../src/modules/ai/image-result-store.js');
  const { waitForGeneratedImageResultStorageMirrors } = await import('../../src/modules/ai/image-service.js');
  const { layerCapability } = await import('../../src/modules/ai/layer-canvas-config.js');
  const fingerprint = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const png = (width: number, height: number, rgba: Parameters<typeof sharp>[0]) => sharp(rgba).resize(width, height).png().toBuffer();
  const base = await png(320, 400, Buffer.from('<svg width="320" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="400" fill="#eecb60"/><path d="M0 310 Q 140 260 320 330 L320 400H0Z" fill="#efaa43"/><text x="22" y="365" font-size="14" fill="#614810">DRAWER / 01</text></svg>'));
  const title = await png(210, 76, Buffer.from('<svg width="210" height="76" xmlns="http://www.w3.org/2000/svg"><text x="2" y="52" font-family="sans-serif" font-size="47" font-weight="bold" fill="#482836">CLOUD</text></svg>'));
  const cloud = await png(120, 70, Buffer.from('<svg width="120" height="70" xmlns="http://www.w3.org/2000/svg"><path fill="#fff6ec" d="M22 58C-8 58-5 25 22 25C25 4 57 4 67 23C89 10 118 28 116 45C115 60 101 59 90 59Z"/></svg>'));
  const poster = await sharp(base).composite([{ input: title, left: 27, top: 37 }, { input: cloud, left: 100, top: 175 }]).png().toBuffer();
  const splitPoster = await sharp(poster).resize(640, 800).png().toBuffer();
  const alphaPoster = await sharp(poster).resize(318, 398).ensureAlpha().extend({
    top: 1, right: 1, bottom: 1, left: 1, background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png().toBuffer();
  const jpegDimensions = { width: 1024, height: 768, channels: 3 as const };
  const jpegPixels = Buffer.alloc(jpegDimensions.width * jpegDimensions.height * jpegDimensions.channels);
  let seed = 0x12345678;
  for (let i = 0; i < jpegPixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    jpegPixels[i] = seed >>> 24;
  }
  const splitJpeg = await sharp(jpegPixels, { raw: jpegDimensions }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  const data = (bytes: Buffer) => 'data:image/png;base64,' + bytes.toString('base64');
  const limits = { enabled: true, maxMegapixels: 2, maxLayers: 32 };
  const model = {
    id: 'local-model-id', canonicalModelKey: 'local-layer-model', displayName: '本地图层模型', modality: 'image',
    enabled: true, visible: true, status: 'PUBLISHED', defaultRouteId: 'mock-a', billingType: 'image_flat',
    capabilities: { supportsLayerSplit: true, supportsInteractiveEdit: true }, updatedAt: new Date(), sortOrder: 0,
    routingMode: 'MANAGED', aliases: [], priceVersions: [], pricing: { markupMultiplier: '1.32', pricingMode: 'MANUAL',
      currentVersion: { version: 1, pricing: { billingType: 'image_flat', creditsPerRequest: '1' } } },
  };
  const routes = (['mock-a', 'mock-b'] as const).map((routeId, index) => {
    const adapter = index ? 'pixel-json' : 'canvas-json';
    const channel = { id: routeId, name: routeId, status: 'ACTIVE', kind: 'NEW_API', capabilities: ['IMAGE'],
      baseUrl: index ? 'https://1.0.0.1' : 'https://1.1.1.1', encryptedSecrets: encryptProviderSecrets({ apiKey: 'fixture-only', headers: {} }) };
    return { id: routeId, provider: 'NEW_API', channelId: routeId, canonicalModelId: model.id, channel, canonicalModel: model,
      upstreamModelId: routeId + '-model', upstreamAvailable: true, enabled: true, priority: index,
    healthStatus: 'HEALTHY', pricingSyncStatus: 'UNKNOWN', updatedAt: new Date(), adapterKey: null, costHistory: [],
      adapterConfig: null, costProfile: null, capabilitiesOverride: null,
      metadata: { canvasLayers: {
        split: { ...limits, endpoint: '/split', adapter, creditsPerRequest: '12' },
        edit: { ...limits, endpoint: '/edit', adapter, creditsPerRequest: '8' },
      } },
    };
  });
  const channels = new Map<string, AiProviderChannel>(routes.map(({ channel, priority }) => [
    channel.id, { ...channel, priority, defaultModel: null, allowInsecureHttp: false, apiKeyLast4: 'only',
      lastTestStatus: null, lastTestMessage: null, lastTestModelCount: null, lastTestedAt: null,
      createdAt: new Date(), updatedAt: new Date() } as AiProviderChannel,
  ]));
  const operations = new Map<string, { idempotencyKey: string; result: unknown }>();
  const usageBindings = new Map<string, { key: string; canonicalModelId: string }>();
  const calls: { channel: string; method: string | undefined; url: string; body: Record<string, unknown>;
    customTransport: boolean; arkClientRequestId: string | null }[] = [];
  const sourceKey = 'reference-images/layer-test-source.png';
  const splitSourceKey = 'reference-images/layer-test-split-source.png';
  const splitJpegKey = 'reference-images/layer-test-split-source.jpg';
  const arkSourceUrl = (objectKey: string) => `https://canvas-reference-fixture-1250000000.cos.ap-beijing.myqcloud.com/${objectKey}?signed=fixture-only`;
  const referenceFixtures: Record<string, { bytes: Buffer; contentType: string; owner: string }> = {
    [sourceKey]: { bytes: alphaPoster, contentType: 'image/png', owner: 'local-test-user' },
    [splitSourceKey]: { bytes: splitPoster, contentType: 'image/png', owner: 'local-test-user' },
    [splitJpegKey]: { bytes: splitJpeg, contentType: 'image/jpeg', owner: 'local-test-user' },
    'reference-images/foreign-layer-test-source.png': { bytes: poster, contentType: 'image/png', owner: 'different-test-user' },
  };
  const uselgReads: string[] = [];
  const arkLayerReads: string[] = [];
  const arkEditAssets = new Map<string, Buffer>();
  const transientArkLayerFailures = new Set<string>();
  let arkRecoveryAssetsAvailable = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.href === 'https://8.8.8.8/api/v3/models' && init?.method === 'GET') {
      return Response.json({ object: 'list', data: [{ id: 'doubao-seedream-fixture', domain: 'ImageGeneration' }] });
    }
    if (target.origin === 'https://9.9.9.9' && target.pathname === '/canvas-edit.png' && init?.method === 'GET') {
      uselgReads.push(target.origin + target.pathname);
      if (new Headers(init.headers).has('authorization')) return new Response(null, { status: 403 });
      return new Response(new Uint8Array(poster), { headers: { 'content-type': 'image/png' } });
    }
    if (target.origin === 'https://9.9.9.9' && target.pathname.startsWith('/ark-edits/') && init?.method === 'GET') {
      const bytes = arkEditAssets.get(target.href);
      if (!bytes || new Headers(init.headers).has('authorization')) return new Response(null, { status: 403 });
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } });
    }
    if (['https://9.9.9.9', 'https://ark-layer.example.test'].includes(target.origin)
      && target.pathname.startsWith('/ark-layers/') && init?.method === 'GET') {
      const name = target.pathname.slice('/ark-layers/'.length, -'.png'.length);
      const asset = { base, title, cloud }[name as 'base' | 'title' | 'cloud'];
      const signature = target.searchParams.get('signature');
      arkLayerReads.push(name);
      if (!asset || !signature || new Headers(init.headers).has('authorization')) {
        return new Response(null, { status: 403 });
      }
      if (signature === 'unavailable') return new Response(null, { status: 503 });
      if (signature === 'recoverable') {
        const headers = new Headers(init.headers);
        const etag = '"fixture-title"';
        const end = asset.length;
        if (!headers.has('range')) {
          return new Response(new Uint8Array(asset.subarray(0, 32)), { headers: { etag, 'content-length': String(end) } });
        }
        if (!arkRecoveryAssetsAvailable) return new Response(null, { status: 503 });
        if (headers.get('range') !== 'bytes=32-' || headers.get('if-range') !== etag) return new Response(null, { status: 416 });
        return new Response(new Uint8Array(asset.subarray(32)), { status: 206, headers: {
          etag, 'content-range': `bytes 32-${end - 1}/${end}`, 'content-type': 'image/png',
        } });
      }
      if (signature === 'retry-once' && !transientArkLayerFailures.has(target.pathname)) {
        transientArkLayerFailures.add(target.pathname);
        return new Response(null, { status: 503 });
      }
      if (!['fixture', 'retry-once'].includes(signature)) return new Response(null, { status: 403 });
      return new Response(new Uint8Array(asset), { headers: { 'content-type': 'image/png' } });
    }
    const route = routes.find(entry => new URL(entry.channel.baseUrl).origin === target.origin);
    if (!route) {
      if (target.hostname === '127.0.0.1') return realFetch(url, init);
      throw new Error('Local fixture blocked a non-local fetch');
    }
    if (init?.method === 'GET' && target.pathname.startsWith('/v1/images/tasks/')) {
      uselgReads.push(target.pathname + target.search);
      if (new Headers(init.headers).get('authorization') !== 'Bearer fixture-only') {
        return Response.json({ error: 'missing fixture credential' }, { status: 401 });
      }
      if (target.pathname.endsWith('/assets/0')) {
        return new Response(new Uint8Array(poster), { headers: { 'content-type': 'image/png' } });
      }
      if (target.pathname.endsWith('/expired')) return new Response(null, { status: 403 });
      if (target.searchParams.get('view') === 'summary') {
        return Response.json({ task_id: 'imgtask-layer-edit-fixture', status: 'succeeded' });
      }
      return Response.json({ task_id: 'imgtask-layer-edit-fixture', status: 'succeeded',
        assets: [{ download_url: '/v1/images/tasks/imgtask-layer-edit-fixture/assets/0' }] });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ channel: route.id, method: init?.method, url: target.href, body,
      customTransport: Boolean((init as RequestInit & { dispatcher?: unknown })?.dispatcher),
      arkClientRequestId: new Headers(init?.headers).get('x-client-request-id') });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const pixel = route.id === 'mock-b';
    if (target.pathname === '/v1/images/edits') {
      if (body.prompt === 'direct asset') return Response.json({ data: [{ download_url: '/v1/images/tasks/direct/assets/0' }] });
      if (body.prompt === 'signed asset') return Response.json({ data: [{ url: 'https://9.9.9.9/canvas-edit.png?signature=fixture' }] });
      if (body.prompt === 'expired asset') return Response.json({ data: [{ url: '/v1/images/tasks/direct/expired' }] });
      return Response.json({ task_id: 'imgtask-layer-edit-fixture', status: 'queued', poll_after_ms: 1000 }, { status: 202 });
    }
    if (target.pathname === '/images/generations' || target.pathname === '/api/v3/images/generations') {
      if (body.layer_decomposition === true && body.prompt === 'ark-unsupported-parameter-fixture') {
        return Response.json({ error: {
          code: 'InvalidParameter.UnsupportedParameter',
          param: 'layer_decomposition',
          message: 'Unsupported parameter layer_decomposition for fake-secret and https://example.test/signed.png?signature=fixture-secret',
        } }, { status: 400 });
      }
      if (body.prompt === 'ark-timeout-fixture') {
        throw Object.assign(new Error('Provider response exceeded the deadline'), { code: 'IMAGE_PROVIDER_RESPONSE_TIMEOUT' });
      }
      if (body.prompt === 'ark-image-download-timeout-fixture') {
        return Response.json({ error: { code: 'InvalidParameter', param: 'image', message: 'Image download timeout' } }, { status: 400 });
      }
      const source = String(body.image);
      const inline = /^data:image\/(?:png|jpeg|webp);base64,/.test(source);
      const signedReference = Object.entries(referenceFixtures).find(([key]) => source === arkSourceUrl(key))?.[1];
      if (!inline && !signedReference) {
        return Response.json({ error: { code: 'InvalidParameter', param: 'image', message: 'Image download timeout' } }, { status: 400 });
      }
      const bytes = signedReference?.bytes ?? Buffer.from(source.split(',')[1] ?? '', 'base64');
      if (body.layer_decomposition === true) {
        const exhaustDownloadRetry = body.prompt === 'ark-exhausted-layer-asset-retry-fixture';
        const recoverable = body.prompt === 'ark-recover-layer-asset-fixture';
        const cloudSignature = body.prompt === 'ark-expired-layer-asset-fixture' ? 'expired'
          : body.prompt === 'ark-retry-layer-asset-fixture' ? 'retry-once' : 'fixture';
        const titleSignature = exhaustDownloadRetry ? 'unavailable' : recoverable ? 'recoverable' : 'fixture';
        const baseSignature = exhaustDownloadRetry ? 'retry-once' : 'fixture';
        const arkLayerAsset = (name: string, bytes: Buffer, signature: string) => body.response_format === 'url'
          ? { url: `https://${recoverable ? 'ark-layer.example.test' : '9.9.9.9'}/ark-layers/${name}.png?signature=${signature}` }
          : { b64_json: bytes.toString('base64') };
        const result = { data: [
          { ...arkLayerAsset('cloud', cloud, cloudSignature), size: '120x70', z_index: 2, name: '云朵',
            bounding_box: { absolute: [100, 175, 196, 231] } },
          { ...arkLayerAsset('base', base, baseSignature), size: '320x400', z_index: 0 },
          { ...arkLayerAsset('title', title, titleSignature), size: '210x76', z_index: 1, name: '标题',
            bounding_box: { absolute: [27, 37, 237, 113] } },
        ] };
        if (body.prompt === 'ark-oversized-output-fixture') {
          return Response.json(result, { headers: { 'content-length': String(64 * 1024 ** 2 + 1) } });
        }
        return Response.json(result);
      }
      const output = await sharp(bytes).tint('#8b95ed').png().toBuffer();
      if (body.response_format === 'url') {
        const url = `https://9.9.9.9/ark-edits/${fingerprint(output)}.png?signature=fixture`;
        arkEditAssets.set(url, output);
        return Response.json({ data: [{ url }] });
      }
      return Response.json({ data: [{ b64_json: output.toString('base64') }] });
    }
    if (target.pathname === '/edit') {
      const input = String(pixel ? body.input_image : body.image);
      const bytes = Buffer.from(input.split(',')[1] ?? '', 'base64');
      const output = await sharp(bytes).tint('#8b95ed').png().toBuffer();
      return Response.json(pixel ? { result: { output: { b64_json: output.toString('base64') } } } : { data: { image: data(output) } });
    }
    if (target.pathname !== '/split') return new Response('Unknown mock endpoint', { status: 404 });
    const layers = [{ name: '标题', x: 27, y: 37, width: 210, height: 76, image: data(title) },
      { name: '云朵', x: 100, y: 175, width: 120, height: 70, image: data(cloud) }];
    return Response.json(pixel ? { result: { width: 320, height: 400, background: data(base),
      layers: layers.map(layer => ({ title: layer.name, bounds: [layer.x, layer.y, layer.width, layer.height], file: layer.image })) } }
      : { data: { canvas: { width: 320, height: 400, base: data(base) }, layers } });
  };
  const records: Record<string, any>[] = [];
  const ledger: Record<string, unknown>[] = [];
  let availableCredits = creditDecimal(100);
  let reservedCredits = creditDecimal(0);
  let queue: Promise<unknown> = Promise.resolve();
  const matchesRequest = (row: Record<string, any>, where: any): boolean => {
    if (where.userId_clientRequestId) {
      return row.userId === where.userId_clientRequestId.userId
        && row.clientRequestId === where.userId_clientRequestId.clientRequestId;
    }
    if ((where.id && row.id !== where.id) || (where.userId && row.userId !== where.userId)
      || (where.capability && row.capability !== where.capability)) return false;
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(row.status)) return false;
    if (where.result?.path) {
      const value = where.result.path.reduce((item: any, key: string) => item?.[key], row.result);
      if ('equals' in where.result && value !== where.result.equals) return false;
      if ('lte' in where.result && (typeof value !== 'string' || value > where.result.lte)) return false;
    }
    return !where.AND || where.AND.every((condition: any) => matchesRequest(row, condition));
  };
  const find = ({ where }: { where: any }) => records.find(row => matchesRequest(row, where)) ?? null;
  const updateWallet = ({ data }: { data: any }) => {
    availableCredits = availableCredits.plus(data.availableCredits?.increment ?? 0).minus(data.availableCredits?.decrement ?? 0);
    reservedCredits = reservedCredits.plus(data.reservedCredits?.increment ?? 0).minus(data.reservedCredits?.decrement ?? 0);
    return { availableCredits, reservedCredits };
  };
  const details = () => ({ ...model, routes: routes.map(({ canonicalModel, channel, ...route }) => ({
    ...route, channel: { id: channel.id, name: channel.name, status: channel.status, kind: channel.kind },
  })), _count: { requests: records.length, billingSettlements: 0, usageBindings: 0 } });
  const prisma = {
    aiProviderChannel: {
      findMany: async () => [...channels.values()],
      findUnique: async ({ where }: { where: { id: string } }) => channels.get(where.id) ?? null,
      create: async ({ data }: { data: Partial<AiProviderChannel> }) => {
        const channel = { ...data, id: randomUUID(), createdAt: new Date(), updatedAt: new Date(),
          lastTestStatus: null, lastTestMessage: null, lastTestModelCount: null, lastTestedAt: null } as AiProviderChannel;
        channels.set(channel.id, channel);
        return channel;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<AiProviderChannel> }) =>
        Object.assign(channels.get(where.id)!, data, { updatedAt: new Date() }),
      updateMany: async ({ where, data }: { where: { id: string }; data: Partial<AiProviderChannel> }) => {
        const channel = channels.get(where.id);
        if (channel) Object.assign(channel, data);
        return { count: Number(Boolean(channel)) };
      },
      delete: async ({ where }: { where: { id: string } }) => channels.delete(where.id),
    },
    adminOperation: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) => operations.get(where.idempotencyKey) ?? null,
      create: async ({ data }: { data: { idempotencyKey: string; result: unknown } }) => operations.set(data.idempotencyKey, data),
    },
    aiModel: { count: async () => 1, findUnique: async ({ where }: any) => where.canonicalModelKey === model.canonicalModelKey || where.id === model.id ? details() : null,
      findUniqueOrThrow: async () => details(),
      updateMany: async ({ data }: any) => { Object.assign(model, data, { updatedAt: new Date() }); return { count: 1 }; },
      findMany: async ({ where }: any) => (
        (where?.modality === undefined || where.modality === model.modality)
        && (where?.visible === undefined || where.visible === model.visible)
        && (where?.enabled === undefined || where.enabled === model.enabled)
        && (where?.status === undefined || where.status === model.status)
      ) ? [details()] : [] },
    aiModelAlias: {
      findUnique: async ({ where }: { where: { modality_aliasKey: { modality: string; aliasKey: string } } }) =>
        where.modality_aliasKey.modality === 'image' && where.modality_aliasKey.aliasKey === 'locallayeralias'
          ? { canonicalModel: details() } : null,
    },
    aiModelRoute: {
      findMany: async ({ where }: any) => {
        const [field, operation] = where.metadata.path as [string, 'split' | 'edit'];
        if (field === 'canvasLayerTaskPreferred') return routes.filter(route =>
          route.canonicalModelId === where.canonicalModelId && route.id !== where.id.not
          && (route.metadata as { canvasLayerTaskPreferred?: Record<string, boolean> }).canvasLayerTaskPreferred?.[operation]);
        const { id, canonicalModelKey, capabilities, visible } = where.canonicalModel;
        if ((id && id !== model.id) || (canonicalModelKey && canonicalModelKey !== model.canonicalModelKey)
          || (visible !== undefined && visible !== model.visible)
          || (capabilities && !model.capabilities[layerCapability[operation]])) return [];
        return routes.filter(route => route.metadata.canvasLayers[operation]?.enabled);
      },
      findFirst: async ({ where }: any) => routes.find(route => route.id === where.id) ?? null,
      findUnique: async ({ where }: any) => routes.find(route => route.id === where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(routes.find(route => route.id === where.id)!, data),
    },
    aiUpstreamDiscovery: { findMany: async () => [] },
    referenceUpload: {
      findFirst: async ({ where }: { where: { objectKey: string; userId: string } }) => {
        const reference = referenceFixtures[where.objectKey];
        if (!reference || reference.owner !== where.userId) return null;
        return { id: where.objectKey, objectKey: where.objectKey, status: 'UPLOADED',
          sizeBytes: reference.bytes.length, contentType: reference.contentType };
      },
    },
    aiUsageModelBinding: {
      findMany: async () => [],
      findFirst: async ({ where }: { where: { canonicalModelId: string; key: { in: string[] } } }) =>
        [...usageBindings.values()].find(binding => binding.canonicalModelId === where.canonicalModelId
          && where.key.in.includes(binding.key)) ?? null,
      findUnique: async ({ where }: { where: { key: string } }) => {
        const binding = usageBindings.get(where.key);
        return binding ? { ...binding, canonicalModel: model } : null;
      },
      upsert: async ({ where, create }: { where: { key: string }; create: { key: string; canonicalModelId: string } }) =>
        usageBindings.set(where.key, create),
    },
    aiBillingSettlement: { create: async () => ({}) },
    aiRequest: { findUnique: async (query: any) => find(query), findFirst: async (query: any) => find(query),
      findMany: async ({ where, take }: any) => records.filter(row => matchesRequest(row, where))
        .slice(0, take).map(row => ({ ...row })),
      create: async ({ data }: any) => { const row = { id: randomUUID(), chargedCredits: 0, ...data }; records.push(row); return row; },
      updateMany: async ({ where, data }: any) => { const row = find({ where }); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; } },
    wallet: { updateMany: async ({ where, data }: any) => {
      if (availableCredits.lt(where.availableCredits.gte)) return { count: 0 };
      updateWallet({ data }); return { count: 1 };
    }, findUniqueOrThrow: async () => ({ availableCredits, reservedCredits }), update: async (query: any) => updateWallet(query) },
    walletLedger: { create: async ({ data }: any) => { ledger.push(data); return data; } },
    adminAuditLog: { create: async () => ({}) },
    $transaction: (run: (tx: unknown) => unknown) => {
      const next = queue.then(() => run(prisma));
      queue = next.catch(() => {});
      return next;
    },
  };
  const app = Fastify({ bodyLimit: 30 * 1024 * 1024 });
  await app.register(cors, { origin: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
  app.decorate('prisma', prisma as unknown as PrismaClient);
  app.decorate('authenticateAccessToken', async request => {
    request.user = { sub: 'local-test-user' } as typeof request.user;
  });
  await app.register(aiRoutes, { prefix: '/v1/ai' });
  await app.register(aiModelAdminRoutes, { prefix: '/v1/admin/ai-models' });
  await app.register(providerAdminRoutes, { prefix: '/v1/admin/providers' });
  app.get('/v1/admin/overview', async () => ({ users: { total: 1, active: 1 }, licenses: { active: 1 },
    credits: { available: availableCredits.toString(), reserved: reservedCredits.toString(), lifetimeGranted: '100', lifetimeConsumed: '0' } }));
  app.get('/v1/admin/usage', async () => {
    const date = new Date().toISOString().slice(0, 10);
    return { date, days: 1, startDate: date, endDate: date, timeZone: 'Asia/Shanghai', range: { start: date, end: date },
      generatedAt: new Date().toISOString(), totals: { activeUsers: 0, imageRequests: 0, imageCount: '0', tokenRequests: 0,
        tokenRequestsWithUsage: 0, tokenRequestsWithoutUsage: 0, inputTokens: '0', cachedInputTokens: '0', cacheWriteTokens: '0',
        outputTokens: '0', totalTokens: '0', imageModels: [] }, items: [] };
  });
  for (const path of ['users', 'redemption-codes', 'inspiration-space', 'membership/plans', 'referral-rules']) {
    app.get('/v1/admin/' + path, async () => ({ items: [] }));
  }
  app.get('/fixture/poster.png', async (_request, reply) => reply.type('image/png').send(poster));
  app.get('/fixture/receipt', async () => ({
    calls: calls.map(({ channel, body }) => ({ channel, action: body.action ?? body.operation, selection: body.selection ?? body.region_pixels })),
    balance: availableCredits.toString(), reservations: reservedCredits.toString(),
    ledger: ledger.map(row => ({ type: row.type, amount: String(row.amount) })), hashes: { poster: fingerprint(poster) },
  }));
  app.post('/fixture/cache', async (request, reply) => {
    const image = (request.body as { image?: string }).image;
    if (!image?.startsWith('data:image/png;base64,')) return reply.code(400).send({ error: 'invalid PNG' });
    const bytes = Buffer.from(image.split(',')[1]!, 'base64');
    return { url: await createImageResultFromResponse(new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } })) };
  });
  await app.listen({ port, host: '127.0.0.1' });
  return { app, paths: { base: data(base), poster: data(poster), sourceKey, alphaPoster: data(alphaPoster),
    splitPoster: data(splitPoster), splitSourceKey, splitJpegKey, splitJpeg, arkSourceUrl }, upstreamCalls: () => [...calls],
    useMockAProviderKind(kind: AiProviderChannel['kind'], baseUrl = 'https://1.1.1.1') {
      Object.assign(routes[0]!.channel, { kind, baseUrl });
    },
    uselgReads: () => [...uselgReads],
    arkLayerReads: () => [...arkLayerReads],
    allowArkRecoveryAssets: () => { arkRecoveryAssetsAvailable = true; },
    arkDownloadDueAt: (clientRequestId: string) => {
      const dueAt = records.find(row => row.clientRequestId === clientRequestId)?.result?.arkDownloadDueAt;
      return typeof dueAt === 'string' ? new Date(dueAt) : null;
    },
    failureDiagnostic: (clientRequestId: string) => records.find(row => row.clientRequestId === clientRequestId)?.failureDiagnostic as unknown,
    close: async () => {
      try {
        await app.close();
        await waitForGeneratedImageResultStorageMirrors();
      } finally { globalThis.fetch = realFetch; }
    } };
}
