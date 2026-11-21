import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { decryptProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl } from '../providers/url.js';
import { isStoredImageResultUrl } from './image-result-store.js';
import { providerRequest, persistGeneratedImageResultsAndScheduleMirrors } from './image-service.js';
import { jsonRecord, layerCandidates } from './layer-canvas-config.js';
import { canvasSourceDimensions, decodeCanvasLayerResult, layerUpstreamBody, type CanvasLayerInput } from './layer-canvas-adapters.js';
import { CloudAiError, releaseCredits, reserveCredits, settleCredits } from './service.js';
import { serializeCredit } from '../wallets/credit-amount.js';
import { toInputJson } from './pricing-center.js';

const identity = (userId: string, clientRequestId: string) => ({ userId_clientRequestId: { userId, clientRequestId } });
const unavailable = () => new CloudAiError('layer_route_unavailable', '该操作尚未配置可用的模型、渠道或价格', 409);

export async function getCanvasLayerRequest(prisma: PrismaClient, userId: string, clientRequestId: string, fingerprint?: string) {
  const row = await prisma.aiRequest.findUnique({ where: identity(userId, clientRequestId) });
  if (!row) return null;
  const result = jsonRecord(row.result);
  if (result.canvasLayersVersion !== 1 || fingerprint && result.fingerprint !== fingerprint) {
    if (fingerprint) throw new CloudAiError('duplicate_request', '请求 ID 已被其他操作使用', 409);
    return null;
  }
  return {
    clientRequestId,
    status: row.status === 'SUCCEEDED' ? 'success' : row.status === 'FAILED' || row.status === 'REFUNDED' ? 'failed' : 'processing',
    model: row.logicalModel,
    chargedCredits: serializeCredit(row.chargedCredits),
    ...(row.status === 'SUCCEEDED' ? { result: result.result } : {}),
    ...(row.status === 'FAILED' || row.status === 'REFUNDED' ? { message: result.message ?? '请求已结束，积分已释放' } : {}),
  };
}

export async function submitCanvasLayerRequest(prisma: PrismaClient, userId: string, input: CanvasLayerInput) {
  const { clientRequestId, operation } = input;
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const existing = await getCanvasLayerRequest(prisma, userId, clientRequestId, fingerprint);
  if (existing) return existing;
  const [selected] = await layerCandidates(prisma, operation, input.model);
  if (!selected) throw unavailable();
  const { route, provider, model, config } = selected;
  const chargedCredits = serializeCredit(config.creditsPerRequest);
  if (input.expectedCredits !== undefined && serializeCredit(input.expectedCredits) !== chargedCredits) {
    throw new CloudAiError('layer_price_changed', '积分价格已调整，请核对后重新运行', 409);
  }
  let source;
  try { source = await canvasSourceDimensions(input.image); }
  catch { throw new CloudAiError('invalid_source_image', '输入图片损坏、格式不受支持或尺寸超限', 400); }
  const journal = { canvasLayersVersion: 1, fingerprint, operation, adapter: config.adapter, creditsPerRequest: chargedCredits };
  let requestId;
  try {
    requestId = await reserveCredits(prisma, {
      userId, clientRequestId, capability: 'IMAGE', logicalModel: model.canonicalModelKey,
      canonicalModelId: model.id, routeId: route.id, description: '画布图层操作预留',
      credits: chargedCredits, initialResult: journal,
    });
  } catch (error) {
    const replay = await getCanvasLayerRequest(prisma, userId, clientRequestId, fingerprint);
    if (replay) return replay;
    throw error;
  }
  try {
    await assertPublicProviderUrl(provider.baseUrl);
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    const body = await layerUpstreamBody(config.adapter, input, route.upstreamModelId, source);
    const upstream = await providerRequest(provider, secrets, config.endpoint, body, 180_000,
      { 'Idempotency-Key': requestId });
    const decoded = await decodeCanvasLayerResult(config, operation, upstream);
    const assets = await persistGeneratedImageResultsAndScheduleMirrors(decoded.assets, provider.name, {
      clientRequestId, canonicalModel: model.canonicalModelKey, routeId: route.id, providerId: provider.id, adapterKey: config.adapter,
    });
    if (decoded.assets.length !== assets.length || assets.some(asset => !isStoredImageResultUrl(asset))) {
      throw new Error('Result assets failed persistence');
    }
    await settleCredits(prisma, userId, requestId, {
      chargedCredits, description: '画布图层操作结算',
      result: toInputJson({ ...journal, result: { ...decoded.structure, assets } }) as Prisma.InputJsonObject,
      breakdown: { operation, imageCount: assets.length, outputPixels: decoded.pixels,
        creditsPerRequest: chargedCredits, totalCredits: chargedCredits },
    });
  } catch {
    await releaseCredits(prisma, userId, requestId, undefined, { ...journal,
      message: '渠道调用失败，或返回的图片、图层位置和尺寸不符合要求。预留积分已释放。' });
  }
  return getCanvasLayerRequest(prisma, userId, clientRequestId);
}
