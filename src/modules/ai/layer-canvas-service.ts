import { createHash } from 'node:crypto';
import type { AiModelRoute, AiProviderChannel, Prisma, PrismaClient } from '@prisma/client';
import { decryptProviderSecrets, type ProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl } from '../providers/url.js';
import { isStoredImageResultUrl } from './image-result-store.js';
import { storageService } from '../storage/service.js';
import { configuredImageTaskEnvelope, imageTaskResultContent, providerRequest, resolveImageAdapterResponse,
  persistGeneratedImageResultsAndScheduleMirrors } from './image-service.js';
import { normalizeImageTaskExecutionConfig } from './image-execution.js';
import { buildFailureDiagnostic } from './failure-diagnostic.js';
import { jsonRecord, layerCandidates, type LayerRoute } from './layer-canvas-config.js';
import { canvasLayerEditOutput, canvasResultBytes, canvasSourceDimensions, decodeCanvasLayerResult, layerUpstreamBody,
  type CanvasLayerInput } from './layer-canvas-adapters.js';
import { CloudAiError, releaseCredits, reserveCredits, settleCredits } from './service.js';
import { serializeCredit } from '../wallets/credit-amount.js';
import { toInputJson } from './pricing-center.js';
import { authorizeReferenceObject } from './reference-upload-service.js';
import { prepareGenericImageDataUrlReference } from './seedream-references.js';

const identity = (userId: string, clientRequestId: string) => ({ userId_clientRequestId: { userId, clientRequestId } });
const unavailable = () => new CloudAiError('layer_route_unavailable', '该操作尚未配置可用的模型、渠道或价格', 409);

async function readLayerInputImage(prisma: PrismaClient, userId: string, image: string) {
  if (!image.startsWith('reference-images/')) return image;
  const objectKey = await authorizeReferenceObject(prisma, userId, image);
  const prepared = await prepareGenericImageDataUrlReference(storageService.getDownloadUrl(objectKey));
  return prepared.value;
}

const stageMessages = {
  canvas_layer_submit: '提交给上游渠道时失败。',
  canvas_layer_result: '未能从上游任务取回编辑图片。',
  canvas_layer_download: '上游返回了图片地址，但下载失败。',
  canvas_layer_decode: '渠道回包缺少可用图片，或图片格式、图层位置、尺寸超出配置要求。',
  result_persistence: '上游图片已返回，但保存到灵感抽屉失败。',
} as const;

async function resolveLayerEditTask(
  provider: AiProviderChannel,
  secrets: ProviderSecrets,
  route: Pick<AiModelRoute, 'executionMode' | 'executionConfig'>,
  config: LayerRoute,
  reply: unknown,
  inputImage: string,
  onTaskId: (id: string) => Promise<void>,
) {
  const taskRoute = route.executionMode === 'TASK';
  if (provider.kind !== 'USELG' && !taskRoute) return reply;

  const execution = normalizeImageTaskExecutionConfig(
    taskRoute ? route.executionConfig : {
      profile: 'USELG_IMAGE_TASK', resultEndpointTemplate: '/v1/images/tasks/{taskId}',
    },
    { submitEndpoint: config.endpoint },
  );
  const envelope = configuredImageTaskEnvelope(reply, execution);
  const state = typeof envelope.status === 'string' ? envelope.status : '';
  const taskId = typeof envelope.task_id === 'string' ? envelope.task_id : '';
  if (/^[a-zA-Z0-9_.:-]{1,128}$/.test(taskId)) await onTaskId(taskId);
  if (canvasLayerEditOutput(config.adapter, reply)
    && !/^(?:queued|pending|processing|running|in_progress|waiting|failed|failure|error|cancelled|canceled|rejected|paused|uncertain|client_disconnected|pending_confirmation)$/.test(state)) return reply;
  // The shared image reader polls this submitted task and downloads its assets
  // with GET only. The edit adapter still owns raster validation and placement.
  const [output] = await resolveImageAdapterResponse(provider, secrets, envelope, [inputImage], 1, undefined,
    async (path, _body, timeout) => configuredImageTaskEnvelope(
      await providerRequest(provider, secrets, path, undefined, timeout), execution, taskId,
    ),
    undefined,
    async (path, timeout) => {
      const result = await imageTaskResultContent(provider, secrets, path, timeout);
      return typeof result === 'string' ? result : configuredImageTaskEnvelope(result, execution, taskId);
    },
    undefined, true);
  return { data: [{ url: output }] };
}

async function readLayerEditAsset(provider: AiProviderChannel, secrets: ProviderSecrets, source: string) {
  const target = new URL(source, provider.baseUrl);
  if (target.origin !== new URL(provider.baseUrl).origin) return source;
  const result = await imageTaskResultContent(provider, secrets, target.href, 45_000);
  if (typeof result !== 'string' || !isStoredImageResultUrl(result)) throw new Error('Asset endpoint did not return image bytes');
  return result;
}

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
  const image = await readLayerInputImage(prisma, userId, input.image);
  const preparedInput = { ...input, image };
  let source;
  try { source = await canvasSourceDimensions(image); }
  catch { throw new CloudAiError('invalid_source_image', '输入图片损坏、格式不受支持或尺寸超限', 400); }
  const journal = { canvasLayersVersion: 1, fingerprint, operation, adapter: config.adapter, creditsPerRequest: chargedCredits };
  let requestId;
  let stage: keyof typeof stageMessages = 'canvas_layer_submit';
  let upstreamTaskId = '';
  const taskIdentity = () => upstreamTaskId ? { upstreamTaskId } : {};
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
    const body = await layerUpstreamBody(config.adapter, preparedInput, route.upstreamModelId, source, {
      maxLayers: config.maxLayers, canonicalModelKey: model.canonicalModelKey,
    });
    const upstream = await providerRequest(provider, secrets, config.endpoint, body, 180_000,
      { 'Idempotency-Key': requestId });
    stage = 'canvas_layer_result';
    const reply = operation === 'edit' ? await resolveLayerEditTask(
      provider, secrets, route, config, upstream, image, async id => {
        upstreamTaskId = id;
        await prisma.aiRequest.updateMany({
          where: { id: requestId, userId, status: { in: ['RESERVED', 'PROCESSING'] } },
          data: { status: 'PROCESSING', result: { ...journal, upstreamTaskId } },
        });
      },
    ) : upstream;
    stage = 'canvas_layer_decode';
    const decoded = await decodeCanvasLayerResult(config, operation, reply, operation === 'edit' ? async source => {
      if (!/^(?:https?:\/\/|\/(?!\/))/i.test(source) || isStoredImageResultUrl(source)) return canvasResultBytes(source);
      stage = 'canvas_layer_download';
      const bytes = await canvasResultBytes(await readLayerEditAsset(provider, secrets, source));
      stage = 'canvas_layer_decode';
      return bytes;
    } : undefined);
    stage = 'result_persistence';
    const assets = await persistGeneratedImageResultsAndScheduleMirrors(decoded.assets, provider.name, {
      clientRequestId, canonicalModel: model.canonicalModelKey, routeId: route.id, providerId: provider.id, adapterKey: config.adapter,
    });
    if (decoded.assets.length !== assets.length || assets.some(asset => !isStoredImageResultUrl(asset))) {
      throw new Error('Result assets failed persistence');
    }
    await settleCredits(prisma, userId, requestId, {
      chargedCredits, description: '画布图层操作结算',
      result: toInputJson({ ...journal, ...taskIdentity(), result: { ...decoded.structure, assets } }) as Prisma.InputJsonObject,
      breakdown: { operation, imageCount: assets.length, outputPixels: decoded.pixels,
        creditsPerRequest: chargedCredits, totalCredits: chargedCredits },
    });
  } catch (error) {
    const diagnostic = buildFailureDiagnostic(error, { stage });
    console.warn('[canvas_layer_failed]', { clientRequestId, routeId: route.id, adapter: config.adapter,
      ...taskIdentity(), stage: diagnostic.stage, code: diagnostic.code, httpStatus: diagnostic.httpStatus });
    await releaseCredits(prisma, userId, requestId, diagnostic, { ...journal, ...taskIdentity(),
      message: stageMessages[stage] + '预留积分已释放。' });
  }
  return getCanvasLayerRequest(prisma, userId, clientRequestId);
}
