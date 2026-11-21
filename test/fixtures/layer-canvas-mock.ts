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
  process.env.APP_BASE_URL = 'http://127.0.0.1:' + port;
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
  const calls: { channel: string; body: Record<string, unknown>; customTransport: boolean }[] = [];
  const uselgReads: string[] = [];
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
    if (target.origin === 'https://9.9.9.9' && target.pathname.startsWith('/ark-layers/') && init?.method === 'GET') {
      const asset = { base, title, cloud }[target.pathname.slice('/ark-layers/'.length, -'.png'.length) as 'base' | 'title' | 'cloud'];
      if (!asset || target.searchParams.get('signature') !== 'fixture' || new Headers(init.headers).has('authorization')) {
        return new Response(null, { status: 403 });
      }
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
    calls.push({ channel: route.id, body, customTransport: Boolean((init as RequestInit & { dispatcher?: unknown })?.dispatcher) });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const pixel = route.id === 'mock-b';
    if (target.pathname === '/v1/images/edits') {
      if (body.prompt === 'direct asset') return Response.json({ data: [{ download_url: '/v1/images/tasks/direct/assets/0' }] });
      if (body.prompt === 'signed asset') return Response.json({ data: [{ url: 'https://9.9.9.9/canvas-edit.png?signature=fixture' }] });
      if (body.prompt === 'expired asset') return Response.json({ data: [{ url: '/v1/images/tasks/direct/expired' }] });
      return Response.json({ task_id: 'imgtask-layer-edit-fixture', status: 'queued', poll_after_ms: 1000 }, { status: 202 });
    }
    if (target.pathname === '/images/generations' || target.pathname === '/api/v3/images/generations') {
      if (body.prompt === 'ark-timeout-fixture') {
        throw Object.assign(new Error('Provider response exceeded the deadline'), { code: 'IMAGE_PROVIDER_RESPONSE_TIMEOUT' });
      }
      if (body.layer_decomposition === true) {
        return Response.json({ data: [
          { url: 'https://9.9.9.9/ark-layers/cloud.png?signature=fixture', size: '120x70', z_index: 2, name: '云朵',
            bounding_box: { absolute: [100, 175, 196, 231] } },
          { url: 'https://9.9.9.9/ark-layers/base.png?signature=fixture', size: '320x400', z_index: 0 },
          { url: 'https://9.9.9.9/ark-layers/title.png?signature=fixture', size: '210x76', z_index: 1, name: '标题',
            bounding_box: { absolute: [27, 37, 237, 113] } },
        ] });
      }
      const bytes = Buffer.from(String(body.image).split(',')[1] ?? '', 'base64');
      const output = await sharp(bytes).tint('#8b95ed').png().toBuffer();
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
  const find = ({ where }: { where: any }) => records.find(row => where.userId_clientRequestId
    ? row.userId === where.userId_clientRequestId.userId && row.clientRequestId === where.userId_clientRequestId.clientRequestId
    : row.id === where.id && (!where.userId || row.userId === where.userId) && (!where.status?.in || where.status.in.includes(row.status))) ?? null;
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
      update: async ({ where, data }: any) => Object.assign(routes.find(route => route.id === where.id)!, data),
    },
    aiUpstreamDiscovery: { findMany: async () => [] },
    referenceUpload: {
      findFirst: async ({ where }: { where: { objectKey: string; userId: string } }) => {
        const ownerByObject: Record<string, string> = {
          'reference-images/layer-test-source.png': 'local-test-user',
          'reference-images/foreign-layer-test-source.png': 'different-test-user',
        };
        if (ownerByObject[where.objectKey] !== where.userId) return null;
        return { id: where.objectKey, objectKey: where.objectKey, status: 'UPLOADED', sizeBytes: poster.length, contentType: 'image/png' };
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
  return { app, paths: { base: data(base), poster: data(poster) }, upstreamCalls: () => [...calls],
    useMockAProviderKind(kind: AiProviderChannel['kind'], baseUrl = 'https://1.1.1.1') {
      Object.assign(routes[0]!.channel, { kind, baseUrl });
    },
    uselgReads: () => [...uselgReads],
    failureDiagnostic: (clientRequestId: string) => records.find(row => row.clientRequestId === clientRequestId)?.failureDiagnostic as unknown,
    close: async () => {
      try {
        await app.close();
        await waitForGeneratedImageResultStorageMirrors();
      } finally { globalThis.fetch = realFetch; }
    } };
}
