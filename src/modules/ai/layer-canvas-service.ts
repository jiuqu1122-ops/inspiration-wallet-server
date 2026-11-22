import { createHash } from 'node:crypto';
import type { AiModelRoute, AiProviderChannel, Prisma, PrismaClient } from '@prisma/client';
import { Agent } from 'undici';
import { decryptProviderSecrets, type ProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl } from '../providers/url.js';
import { storageService } from '../storage/service.js';
import { createImageResultFromResponse, isStoredImageResultUrl } from './image-result-store.js';
import { configuredImageTaskEnvelope, imageTaskResultContent, providerRequest, resolveImageAdapterResponse,
  persistGeneratedImageResultsAndScheduleMirrors } from './image-service.js';
import { normalizeImageTaskExecutionConfig } from './image-execution.js';
import { buildFailureDiagnostic } from './failure-diagnostic.js';
import { jsonRecord, layerCandidates, type LayerRoute } from './layer-canvas-config.js';
import { canvasLayerEditOutput, canvasResultBytes, canvasSourceDimensions, decodeCanvasLayerResult, layerUpstreamBody,
  prepareArkInlineJpeg, type CanvasLayerInput } from './layer-canvas-adapters.js';
import { CloudAiError, releaseCredits, reserveCredits, settleCredits } from './service.js';
import { serializeCredit } from '../wallets/credit-amount.js';
import { toInputJson } from './pricing-center.js';
import { authorizeReferenceObject, ReferenceUploadError } from './reference-upload-service.js';
import { ARK_CANVAS_ASSET_MAX_MS, createArkCanvasTransfer, downloadArkCanvasResultBytes,
  isRetryableArkCanvasResultDownload, prepareStoredCanvasReference } from './seedream-references.js';
import { createArkSubmitDiagnostics } from './ark-submit-diagnostics.js';
import { openArkLayerOutputCheckpoint, sealArkLayerOutputCheckpoint } from './ark-layer-output-checkpoint.js';

const identity = (userId: string, clientRequestId: string) => ({ userId_clientRequestId: { userId, clientRequestId } });
const unavailable = () => new CloudAiError('layer_route_unavailable', '该操作尚未配置可用的模型、渠道或价格', 409);
// The deployed network has no IPv6 route to Ark. Its IPv4 handshake can also
// outlast Node's default dual-stack connection attempt window.
const beijingArkLayerDispatcher = new Agent({ connect: { family: 4, timeout: 30_000 } });
const BEIJING_ARK_LAYER_SUBMIT_TIMEOUT_MS = 240_000;
const BEIJING_ARK_SPLIT_RESPONSE_BODY_TIMEOUT_MS = 360_000;
const BEIJING_ARK_SPLIT_RESPONSE_BODY_IDLE_TIMEOUT_MS = 180_000;
const BEIJING_ARK_SPLIT_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const ARK_REFERENCE_EXPIRY_SECONDS = 600;
const BEIJING_ARK_LAYER_DOWNLOAD_TIMEOUT_MS = 360_000;
// One claim can make two bounded GET attempts before saving the next layer.
const ARK_LAYER_DOWNLOAD_LEASE_MS = 2 * ARK_CANVAS_ASSET_MAX_MS + 30_000;
const ARK_LAYER_MAX_FAILED_PASSES_PER_ASSET = 3;
class ArkDownloadClaimLost extends Error {}
const ARK_LAYER_DOWNLOAD_RETRY_DELAY_MS = 5_000;
const ARK_LAYER_DOWNLOAD_DUE_PATH = ['arkDownloadDueAt'];
const arkDownloadClaim = (dueAt: string) => ({ path: ARK_LAYER_DOWNLOAD_DUE_PATH, equals: dueAt });

async function readLayerInputImage(prisma: PrismaClient, userId: string, image: string) {
  if (!image.startsWith('reference-images/')) return { image };
  const objectKey = await authorizeReferenceObject(prisma, userId, image);
  const prepared = await prepareStoredCanvasReference(objectKey);
  return { image: prepared.value, storedMime: prepared.sourceMime, objectKey };
}

function signedArkReference(objectKey?: string, mime?: string) {
  if (!objectKey || !((mime === 'image/png' && /\.png$/i.test(objectKey))
    || (mime === 'image/jpeg' && /\.jpe?g$/i.test(objectKey)))) return;

  try {
    const url = storageService.getDownloadUrl(objectKey, { expiresSeconds: ARK_REFERENCE_EXPIRY_SECONDS });
    const target = new URL(url);
    const host = /^[a-z0-9-]+\.(?:cos\.([a-z0-9-]+)\.myqcloud\.com|oss-([a-z0-9-]+)\.aliyuncs\.com)$/.exec(target.hostname);
    const region = host?.[1] ?? host?.[2];
    if (target.protocol !== 'https:' || !target.search || target.hash || !region
      || /(?:^|-)(?:internal|intranet|private|vpc)(?:-|$)/.test(region)) return;
    // Storage validates the exact configured bucket and object. Local DNS may
    // resolve the public COS hostname differently from Ark and is irrelevant here.
    return storageService.validateSignedUrl(objectKey, url);
  } catch {
    // Choose the already validated inline data before submitting any request.
    return;
  }
}

const stageMessages = {
  canvas_layer_source: '无法准备供上游读取的参考图。',
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

function arkLayerResultReader(clientRequestId: string, arkRequestId?: string,
  recovery?: { expiresAt: number; transfer: ReturnType<typeof createArkCanvasTransfer> }) {
  const transfer = recovery?.transfer ?? createArkCanvasTransfer();
  const stats = { assetsStarted: 0, retried: false };
  let signal: AbortSignal | undefined;
  return { stats, transfer, async read(source: string, assetNumber = stats.assetsStarted + 1) {
    if (isStoredImageResultUrl(source)) return canvasResultBytes(source);
    const remaining = recovery ? recovery.expiresAt - Date.now() : BEIJING_ARK_LAYER_DOWNLOAD_TIMEOUT_MS;
    signal ??= AbortSignal.timeout(Math.max(1, Math.min(BEIJING_ARK_LAYER_DOWNLOAD_TIMEOUT_MS, remaining)));
    stats.assetsStarted += 1;
    try {
      return await downloadArkCanvasResultBytes(source, signal, transfer);
    } catch (error) {
      if ((!recovery && stats.retried) || signal.aborted || !(error instanceof ReferenceUploadError)
        || !isRetryableArkCanvasResultDownload(error)) throw error;
      stats.retried = true;
      console.warn('[canvas_layer_download_retry]', { clientRequestId, arkRequestId: arkRequestId ?? null,
        assetNumber, code: error.code, httpStatus: error.statusCode, ...transfer });
      return downloadArkCanvasResultBytes(source, signal, transfer);
    }
  } };
}

async function saveCanvasLayerResult(
  prisma: PrismaClient, userId: string, requestId: string, journal: Record<string, unknown>,
  chargedCredits: string, decoded: Awaited<ReturnType<typeof decodeCanvasLayerResult>>,
  providerName: string, trace: Parameters<typeof persistGeneratedImageResultsAndScheduleMirrors>[2],
  downloadDueAt?: string,
) {
  const assets = await persistGeneratedImageResultsAndScheduleMirrors(decoded.assets, providerName, trace);
  if (decoded.assets.length !== assets.length || assets.some(asset => !isStoredImageResultUrl(asset))) {
    throw new Error('Result assets failed persistence');
  }
  await settleCredits(prisma, userId, requestId, {
    chargedCredits, description: '画布图层操作结算',
    ...(downloadDueAt ? { resultCondition: arkDownloadClaim(downloadDueAt) } : {}),
    result: toInputJson({ ...journal, result: { ...decoded.structure, assets } }) as Prisma.InputJsonObject,
    breakdown: { operation: decoded.structure.operation, imageCount: assets.length, outputPixels: decoded.pixels,
      creditsPerRequest: chargedCredits, totalCredits: chargedCredits },
  });
}

export async function recoverNextArkCanvasLayerOutput(prisma: PrismaClient, now = new Date()) {
  const [row] = await prisma.aiRequest.findMany({
    where: { capability: 'IMAGE', status: 'PROCESSING',
      result: { path: ARK_LAYER_DOWNLOAD_DUE_PATH, lte: now.toISOString() } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 1,
    select: { id: true, userId: true, clientRequestId: true, logicalModel: true, routeId: true,
      route: { select: { channelId: true, channel: { select: { name: true } } } },
      estimatedCredits: true, result: true },
  });
  if (!row) return false;
  const { arkDownloadCheckpoint, arkDownloadDueAt, arkDownloadAttempt, arkDownloadRetryAsset, arkDownloadedAssets, ...journal } = jsonRecord(row.result);
  if (typeof arkDownloadCheckpoint !== 'string' || typeof arkDownloadDueAt !== 'string' || journal.operation !== 'split') return false;
  const previousAssets: unknown[] = Array.isArray(arkDownloadedAssets) ? arkDownloadedAssets : [];
  const savedAssets = previousAssets.every((asset): asset is string => typeof asset === 'string' && isStoredImageResultUrl(asset))
    ? [...previousAssets] : [];
  // Earlier receipts counted passes across the entire task. Without an asset
  // number that count cannot be attributed to the next missing layer.
  let retryAsset = typeof arkDownloadRetryAsset === 'number' ? arkDownloadRetryAsset : 0;
  let failedPasses = retryAsset && typeof arkDownloadAttempt === 'number' ? arkDownloadAttempt : 0;
  const startedAt = Date.now();
  const clock = () => now.getTime() + Date.now() - startedAt;
  let claim = arkDownloadDueAt;
  const recordProgress = async (due: number) => {
    const dueAt = new Date(due).toISOString();
    const updated = await prisma.aiRequest.updateMany({
      where: { id: row.id, status: 'PROCESSING', result: arkDownloadClaim(claim) },
      data: { result: toInputJson({ ...journal, arkDownloadCheckpoint, arkDownloadRetryAsset: retryAsset, arkDownloadAttempt: failedPasses,
        arkDownloadDueAt: dueAt, arkDownloadedAssets: savedAssets }) },
    });
    if (updated.count === 1) claim = dueAt;
    return updated.count === 1;
  };
  if (!await recordProgress(clock() + ARK_LAYER_DOWNLOAD_LEASE_MS)) return false;

  let stage: keyof typeof stageMessages = 'canvas_layer_download';
  const checkpoint = openArkLayerOutputCheckpoint({ requestId: row.id, userId: row.userId }, arkDownloadCheckpoint, now.getTime());
  let assetNumber = 0;
  const transfer = createArkCanvasTransfer();
  try {
    if (!checkpoint) throw new Error('Ark layer download checkpoint unavailable or expired');
    const reader = arkLayerResultReader(row.clientRequestId,
      typeof journal.arkRequestId === 'string' ? journal.arkRequestId : undefined, { expiresAt: checkpoint.expiresAt, transfer });
    const decoded = await decodeCanvasLayerResult({ adapter: 'volcengine-ark', ...checkpoint.limits }, 'split', checkpoint.reply,
      async source => {
        const index = assetNumber++;
        stage = 'canvas_layer_decode';
        const local = savedAssets[index];
        if (local) {
          try { return await canvasResultBytes(local); }
          catch { /* The result cache can expire or evict a file. Re-fetch this layer. */ }
        }
        stage = 'canvas_layer_download';
        const bytes = await reader.read(source, assetNumber);
        stage = 'result_persistence';
        savedAssets[index] = await createImageResultFromResponse(new Response(new Uint8Array(bytes)));
        if (assetNumber === retryAsset) {
          retryAsset = 0;
          failedPasses = 0;
        }
        if (!await recordProgress(clock() + ARK_LAYER_DOWNLOAD_LEASE_MS)) throw new ArkDownloadClaimLost();
        stage = 'canvas_layer_decode';
        return bytes;
      });
    stage = 'result_persistence';
    await saveCanvasLayerResult(prisma, row.userId, row.id, journal, serializeCredit(row.estimatedCredits),
      decoded, row.route?.channel?.name ?? 'volcengine-ark', { clientRequestId: row.clientRequestId, canonicalModel: row.logicalModel,
        routeId: row.routeId, providerId: row.route?.channelId ?? 'volcengine-ark', adapterKey: 'volcengine-ark' }, claim);
  } catch (error) {
    if (error instanceof ArkDownloadClaimLost) return false;
    failedPasses = retryAsset === assetNumber ? failedPasses + 1 : 1;
    retryAsset = assetNumber;
    const retryAt = clock() + ARK_LAYER_DOWNLOAD_RETRY_DELAY_MS * failedPasses;
    const retry = stage === 'canvas_layer_download' && error instanceof ReferenceUploadError
      && (error.code === 'ark_result_deadline' || isRetryableArkCanvasResultDownload(error))
      && failedPasses < ARK_LAYER_MAX_FAILED_PASSES_PER_ASSET && checkpoint && retryAt < checkpoint.expiresAt;
    const diagnostic = buildFailureDiagnostic(error, { stage });
    console.warn(retry ? '[canvas_layer_download_recovery_queued]' : '[canvas_layer_download_recovery_failed]', {
      clientRequestId: row.clientRequestId, arkRequestId: journal.arkRequestId ?? null,
      assetNumber, savedCount: savedAssets.length, assetPass: failedPasses, ...(assetNumber ? transfer : {}),
      causeCode: error instanceof ReferenceUploadError ? error.code : null,
      stage: diagnostic.stage, code: diagnostic.code, httpStatus: diagnostic.httpStatus });
    if (retry) return recordProgress(retryAt);
    await releaseCredits(prisma, row.userId, row.id, diagnostic, {
      ...toInputJson(journal) as Prisma.InputJsonObject, message: stageMessages[stage] + '预留积分已释放。',
    }, arkDownloadClaim(claim));
  }
  return true;
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
  const officialBeijingArk = config.adapter === 'volcengine-ark' && provider.kind === 'VOLCENGINE_ARK'
    && new URL(provider.baseUrl).origin === 'https://ark.cn-beijing.volces.com';
  const officialArkSplit = officialBeijingArk && operation === 'split';
  const { image, storedMime, objectKey } = await readLayerInputImage(prisma, userId, input.image);
  let source;
  try { source = await canvasSourceDimensions(image); }
  catch { throw new CloudAiError('invalid_source_image', '输入图片损坏、格式不受支持或尺寸超限', 400); }
  if (officialArkSplit) {
    const pixels = source.width * source.height;
    const ratio = source.width / source.height;
    if (pixels < 512 * 512 || pixels > 6000 * 6000 || ratio < 1 / 16 || ratio > 16) {
      throw new CloudAiError('invalid_source_image', '火山方舟图层拆分要求图片总像素在 262,144 至 36,000,000 之间，宽高比在 1:16 至 16:1 之间', 400);
    }
  }
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
  const processingStartedAt = performance.now();
  let upstreamResponseStatus: number | undefined;
  let arkRequestId: string | undefined;
  let arkImageTransport: 'signed-url' | 'inline' | undefined;
  let arkResponseBytes = 0;
  let arkFirstResponseChunkMs: number | undefined;
  let arkLastResponseChunkMs: number | undefined;
  let arkImagePayloadBytes: number | undefined;
  let arkSubmitDiagnostics: ReturnType<typeof createArkSubmitDiagnostics> | undefined;
  let arkReader: ReturnType<typeof arkLayerResultReader> | undefined;
  try {
    await assertPublicProviderUrl(provider.baseUrl);
    const secrets = decryptProviderSecrets(provider.encryptedSecrets);
    stage = 'canvas_layer_source';
    // Pick the transport before submitting. A trusted signed URL keeps the
    // request body small without resizing or recompressing the reference.
    const arkReferenceUrl = officialBeijingArk ? signedArkReference(objectKey, storedMime) : undefined;
    const upstreamImage = officialArkSplit && !arkReferenceUrl && storedMime === 'image/jpeg'
      ? await prepareArkInlineJpeg(image) : image;
    const body = await layerUpstreamBody(config.adapter, { ...input, image: upstreamImage }, route.upstreamModelId, source, {
      maxLayers: config.maxLayers, canonicalModelKey: model.canonicalModelKey, arkReferenceUrl,
    });
    if (officialBeijingArk && 'image' in body && typeof body.image === 'string') {
      arkImageTransport = arkReferenceUrl ? 'signed-url' : 'inline';
      arkImagePayloadBytes = Buffer.byteLength(body.image);
    }
    stage = 'canvas_layer_submit';
    const submit = () => providerRequest(provider, secrets, config.endpoint, body,
      officialBeijingArk ? BEIJING_ARK_LAYER_SUBMIT_TIMEOUT_MS : 180_000,
      { 'Idempotency-Key': requestId, ...(officialBeijingArk ? { 'X-Client-Request-Id': requestId } : {}) }, (status, headers) => {
        upstreamResponseStatus = status;
        const id = officialBeijingArk ? headers.get('x-request-id') : null;
        if (id && /^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) arkRequestId = id;
      }, undefined,
      officialBeijingArk ? beijingArkLayerDispatcher : undefined,
      officialArkSplit ? {
        maxResponseBytes: BEIJING_ARK_SPLIT_RESPONSE_MAX_BYTES,
        responseBodyTimeoutMs: BEIJING_ARK_SPLIT_RESPONSE_BODY_TIMEOUT_MS,
        responseBodyIdleTimeoutMs: BEIJING_ARK_SPLIT_RESPONSE_BODY_IDLE_TIMEOUT_MS,
        onResponseBodyProgress: bytesReceived => {
          const elapsedMs = Math.round(performance.now() - processingStartedAt);
          arkResponseBytes = bytesReceived;
          arkFirstResponseChunkMs ??= elapsedMs;
          arkLastResponseChunkMs = elapsedMs;
        },
      } : undefined);
    arkSubmitDiagnostics = officialBeijingArk ? createArkSubmitDiagnostics() : undefined;
    const upstream = await (arkSubmitDiagnostics ? arkSubmitDiagnostics.run(submit) : submit());
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
    if (officialArkSplit) {
      stage = 'canvas_layer_decode';
      const sealed = sealArkLayerOutputCheckpoint({ requestId, userId }, reply, config);
      if (!sealed) throw new Error('Could not validate and seal Ark layer output manifest');
      stage = 'result_persistence';
      await prisma.aiRequest.updateMany({
        where: { id: requestId, userId, status: 'RESERVED' },
        data: { status: 'PROCESSING', result: { ...journal, ...(arkRequestId ? { arkRequestId } : {}),
          arkDownloadCheckpoint: sealed, arkDownloadDueAt: new Date().toISOString() } },
      });
      return getCanvasLayerRequest(prisma, userId, clientRequestId);
    }
    arkReader = officialBeijingArk ? arkLayerResultReader(clientRequestId, arkRequestId) : undefined;
    stage = 'canvas_layer_decode';
    const decoded = await decodeCanvasLayerResult(config, operation, reply, async assetSource => {
      const remote = operation === 'edit' ? /^(?:https?:\/\/|\/(?!\/))/i.test(assetSource) : /^https:\/\//i.test(assetSource);
      if (!remote || isStoredImageResultUrl(assetSource)) return canvasResultBytes(assetSource);
      stage = 'canvas_layer_download';
      const asset = operation === 'edit' ? await readLayerEditAsset(provider, secrets, assetSource) : assetSource;
      const bytes = arkReader && /^https:\/\//i.test(asset) ? await arkReader.read(asset) : await canvasResultBytes(asset);
      stage = 'canvas_layer_decode';
      return bytes;
    });
    stage = 'result_persistence';
    await saveCanvasLayerResult(prisma, userId, requestId, { ...journal, ...taskIdentity() }, chargedCredits, decoded, provider.name, {
      clientRequestId, canonicalModel: model.canonicalModelKey, routeId: route.id, providerId: provider.id, adapterKey: config.adapter,
    });
  } catch (error) {
    const diagnostic = buildFailureDiagnostic(error, { stage,
      ...(officialBeijingArk && stage === 'canvas_layer_submit' ? { provider: 'volcengine-ark' } : {}) });
    const arkSubmitTrace = arkSubmitDiagnostics?.snapshot();
    const responseTimeoutPhase = error instanceof Error ? jsonRecord(error.cause).phase : undefined;
    console.warn('[canvas_layer_failed]', {
      clientRequestId, routeId: route.id, adapter: config.adapter,
      ...taskIdentity(), stage: diagnostic.stage, code: diagnostic.code, httpStatus: diagnostic.httpStatus, causeCode: diagnostic.causeCode,
      ...(officialBeijingArk ? { arkClientRequestId: requestId, arkRequestId: arkRequestId ?? null,
        arkImageTransport: arkImageTransport ?? null, arkImagePayloadBytes: arkImagePayloadBytes ?? null,
        arkRequestedResultFormat: 'url',
        ...(officialArkSplit ? {
          arkResponseBytes, arkFirstResponseChunkMs: arkFirstResponseChunkMs ?? null,
          arkLastResponseChunkMs: arkLastResponseChunkMs ?? null,
          ...(responseTimeoutPhase === 'response_body' || responseTimeoutPhase === 'response_body_idle'
            ? { arkResponseTimeoutPhase: responseTimeoutPhase } : {}),
        } : {}),
        ...arkSubmitTrace, arkAssetsStarted: arkReader?.stats.assetsStarted ?? 0,
        arkDownloadRetried: arkReader?.stats.retried ?? false,
        ...(diagnostic.stage === 'canvas_layer_download' && arkReader?.stats.assetsStarted
          ? { arkDownloadTransfer: { ...arkReader.transfer } } : {}),
        arkDownloadErrorCode: diagnostic.stage === 'canvas_layer_download' && error instanceof ReferenceUploadError ? error.code : null,
        arkErrorCode: diagnostic.ark?.code ?? null, arkErrorParameter: diagnostic.ark?.parameter ?? null } : {}),
      upstreamResponseStatus: upstreamResponseStatus ?? null, elapsedMs: Math.round(performance.now() - processingStartedAt) });
    let message: string = stageMessages[stage];
    if (officialArkSplit && stage === 'canvas_layer_submit' && diagnostic.code === 'IMAGE_SIZE_LIMIT') {
      message = '方舟返回的图层数据超过服务端接收上限。';
    }
    if (stage === 'canvas_layer_submit' && diagnostic.code === 'PROVIDER_TIMEOUT') {
      if (officialArkSplit && upstreamResponseStatus === 200) {
        message = '接收方舟返回的图层数据超时。';
      } else if ((upstreamResponseStatus ?? 0) < 400) {
        message = arkSubmitTrace?.arkSubmitPhase === 'sending_request_body'
          ? '向方舟发送请求超时。' : '等待上游渠道响应超时。';
      }
      if (upstreamResponseStatus === 400 && diagnostic.ark?.parameter === 'image') message = '方舟处理参考图超时（HTTP 400）。';
    }
    await releaseCredits(prisma, userId, requestId, diagnostic, { ...journal, ...taskIdentity(),
      message: message + '预留积分已释放。' });
  }
  return getCanvasLayerRequest(prisma, userId, clientRequestId);
}
