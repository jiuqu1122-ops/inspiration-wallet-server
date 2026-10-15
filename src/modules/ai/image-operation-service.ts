import { createHash } from 'node:crypto';
import type { AiRequest, AiModelRoute, AiProviderChannel, Prisma, PrismaClient } from '@prisma/client';
import { decryptProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl } from '../providers/url.js';
import { CloudAiError } from './service.js';
import { imageAdapterConfig } from './image-adapters/types.js';
import { genericImageRequestHeaders } from './image-adapters/generic-request-headers.js';
import { normalizeImageTaskExecutionConfig } from './image-execution.js';
import { resolveCatalogModel, routeCanReceiveTraffic } from './model-catalog.js';
import { capturePricingSnapshot, toInputJson } from './pricing-center.js';
import { resolveReferenceImageSources } from './reference-upload-service.js';
import { prepareGenericImageDataUrlReference } from './seedream-references.js';
import {
  providerRequest, imageTaskResultContent, persistGeneratedImageResultsAndScheduleMirrors,
  imageOperationResultDimensions, configuredImageTaskEnvelope,
} from './image-service.js';
import { imageReadHttpStatus, imageRetryAfterMs } from './image-task-retry.js';
import { extractImageTaskMetadata, mergeImageTaskMetadata, projectImageTaskMetadata, type ImageTaskMetadata } from './image-task-metadata.js';
import { isImageOperationSpeed, type ImageOperation, type ImageOperationSpeed } from './image-operation-pricing.js';
import { reserveOperationCredits, settleOperationCredits, releaseOperationCredits } from './image-operation-wallet.js';
import {
  INITIAL_IMAGE_OPERATIONS, imageOperationInputSchema, imageOperationProviderFingerprint,
  operationRecord, operationValidationError, parseImageOperationContext, validateImageOperationInput,
  validateImageOperationMask, type ImageOperationContext, type ImageOperationInput,
} from './image-operation-protocol.js';

export type WalletImageOperationStatus = 'queued' | 'dispatching' | 'running' | 'paused' | 'uncertain'
  | 'success' | 'failed' | 'canceled' | 'client_disconnected';
export type WalletImageOperationResult = {
  clientRequestId: string;
  status: WalletImageOperationStatus;
  operation: ImageOperation;
  speed: ImageOperationSpeed;
  taskId?: string;
  images: string[];
  texts: string[];
  uploadedUrls: string[];
  requiresModal: boolean;
  taskMetadata?: ImageTaskMetadata;
  chargedCredits: string;
  pollAfterMs?: number;
  errorCode?: string;
};
type OperationJournal = WalletImageOperationResult & {
  imageOperationVersion: 1;
  fingerprint: string;
  providerId: string;
  routeId: string;
  submittedModel: string;
  providerConnectionFingerprint: string;
  receiptKey: string;
  nextRefreshAt: number;
  imageOperationContext?: ImageOperationContext;
};
type OperationRoute = AiModelRoute & { channel: AiProviderChannel | null };
const journalJson = (value: OperationJournal) => toInputJson(value) as Prisma.InputJsonObject;
const refreshes = new Map<string, Promise<WalletImageOperationResult>>();
const terminal = new Set(['success', 'failed', 'canceled', 'client_disconnected']);
const statuses = new Set(['queued', 'dispatching', 'running', 'paused', 'uncertain', ...terminal]);

function failure(code: string, message: string, statusCode = 409): never {
  throw new CloudAiError(code, message, statusCode);
}

function fingerprint(input: ImageOperationInput) {
  return createHash('sha256').update(JSON.stringify({
    model: input.model, operation: input.operation, speed: input.speed ?? null,
    parentClientRequestId: input.parentClientRequestId ?? null, actionId: input.actionId ?? null,
    prompt: input.prompt ?? null, inputImages: input.inputImages ?? [], aspectRatio: input.aspectRatio ?? null,
    dimensions: input.dimensions ?? null, zoom: input.zoom ?? null, maskBase64: input.maskBase64 ?? null,
  })).digest('hex');
}

function readJournal(request: AiRequest): OperationJournal | undefined {
  const row = operationRecord(request.result);
  if (!row || row.imageOperationVersion !== 1 || typeof row.fingerprint !== 'string'
    || typeof row.providerId !== 'string' || typeof row.routeId !== 'string'
    || typeof row.submittedModel !== 'string' || !isImageOperationSpeed(row.speed)) return undefined;
  const journal = row as unknown as OperationJournal;
  return request.status === 'FAILED' && !['failed', 'canceled', 'client_disconnected'].includes(journal.status)
    ? { ...journal, status: 'failed', errorCode: 'image_operation_failed', chargedCredits: '0.000000' } : journal;
}

/** Explicit allowlist: routing, hashes, status URLs and credentials stay private. */
function publicResult(journal: OperationJournal): WalletImageOperationResult {
  const taskMetadata = projectImageTaskMetadata(journal.taskMetadata);
  return {
    clientRequestId: journal.clientRequestId, status: journal.status, operation: journal.operation,
    speed: journal.speed, images: journal.images, texts: journal.texts, uploadedUrls: journal.uploadedUrls,
    requiresModal: journal.requiresModal, chargedCredits: journal.chargedCredits,
    ...(journal.taskId ? { taskId: journal.taskId } : {}),
    ...(taskMetadata ? { taskMetadata } : {}),
    ...(journal.pollAfterMs ? { pollAfterMs: journal.pollAfterMs } : {}),
    ...(journal.errorCode ? { errorCode: journal.errorCode } : {}),
  };
}

async function canonicalResult(prisma: PrismaClient, requestId: string, fallback: OperationJournal) {
  const request = await prisma.aiRequest.findUnique({ where: { id: requestId } });
  return publicResult(request ? readJournal(request) ?? fallback : fallback);
}

function checkedRoute(route: OperationRoute | null | undefined) {
  if (!route || !route.channel || !routeCanReceiveTraffic(route)
    || route.adapterKey !== 'GENERIC_OPENAI_IMAGE' || route.executionMode !== 'TASK') {
    failure('image_operation_route_unavailable', 'The original operation route is unavailable', 503);
  }
  const config = imageAdapterConfig(route.adapterConfig);
  if (config.enableTaskOperations !== true || config.preserveTaskMetadata !== true
    || config.idempotencyHeader !== 'Idempotency-Key') {
    failure('image_operations_disabled', 'Image task operations are not enabled for this route', 409);
  }
  const execution = normalizeImageTaskExecutionConfig(route.executionConfig, {
    submitEndpoint: config.generationEndpoint ?? '/v1/images/generations',
  });
  if (execution.profile !== 'GENERIC_TASK' || execution.submitEndpoint !== '/v1/images/generations') {
    failure('image_operation_route_invalid', 'Operations require the confirmed Generic Images task endpoint');
  }
  if (config.requestParameters?.operation !== 'imagine' || config.requestParameters.n !== 1
    || !isImageOperationSpeed(config.requestParameters.speed)) {
    failure('image_operation_route_invalid', 'The route must explicitly configure imagine, one request and a valid speed');
  }
  return { route, provider: route.channel, config, execution };
}

function validateOperationCapabilities(input: ImageOperationInput, canonical: unknown, route: unknown) {
  if (!INITIAL_IMAGE_OPERATIONS.has(input.operation)) return;
  const referenceCount = input.inputImages?.length ?? 0;
  let maximum = 5;
  let minimum = 0;
  for (const value of [canonical, route]) {
    const capabilities = operationRecord(value);
    if (!capabilities) continue;
    if (referenceCount > 0 && (capabilities.supportsReferenceImages === false
      || capabilities.supportsReferenceImage === false)) {
      operationValidationError('Reference images are disabled for this model or route');
    }
    const configuredMaximum = capabilities.maxReferenceImages;
    if (typeof configuredMaximum === 'number' && Number.isFinite(configuredMaximum)) {
      maximum = Math.min(maximum, Math.max(0, Math.floor(configuredMaximum)));
    }
    const configuredMinimum = capabilities.minReferenceImages;
    if (typeof configuredMinimum === 'number' && Number.isFinite(configuredMinimum)) {
      minimum = Math.max(minimum, Math.max(0, Math.ceil(configuredMinimum)));
    }
    if (input.operation === 'imagine' && input.aspectRatio !== undefined) {
      for (const key of ['aspectRatios', 'supportedAspectRatios']) {
        const configured = capabilities[key];
        if (!Array.isArray(configured) || configured.length === 0) continue;
        if (!configured.some(ratio => typeof ratio === 'string' && ratio.trim() === input.aspectRatio)) {
          operationValidationError('The requested aspect ratio is not supported by this model or route');
        }
      }
    }
  }
  if (referenceCount > maximum) operationValidationError('The reference image count exceeds this model or route limit');
  if (input.operation !== 'shorten' && referenceCount < minimum) {
    operationValidationError('This model or route requires more reference images');
  }
}

function safeTaskId(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) ? value : undefined;
}

function taskEnvelope(value: unknown, taskId?: string): Record<string, unknown> | undefined {
  const row = operationRecord(value);
  if (!row) return undefined;
  const explicit = safeTaskId(row.task_id ?? row.taskId);
  if (explicit) return !taskId || taskId === explicit ? row : undefined;
  for (const key of ['data', 'task', 'result', 'response']) {
    const nested = operationRecord(row[key]);
    if (!nested) continue;
    const id = safeTaskId(nested.task_id ?? nested.taskId);
    if (id && (!taskId || taskId === id)) return nested;
  }
  return undefined;
}

function statusUrl(provider: AiProviderChannel, taskId: string, value: unknown, template?: string) {
  const candidate = typeof value === 'string' && value.length <= 4096
    ? value : template?.replaceAll('{taskId}', encodeURIComponent(taskId))
      ?? `/v1/images/tasks/${encodeURIComponent(taskId)}?view=summary`;
  const url = new URL(candidate, `${provider.baseUrl.replace(/\/+$/, '')}/`);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(provider.baseUrl).origin
    || url.username || url.password || url.hash) failure('image_operation_status_invalid', 'The provider returned an unsafe task status URL');
  return url.toString();
}

async function saveJournal(prisma: PrismaClient, request: AiRequest, journal: OperationJournal) {
  // A late task-list response must never erase a receipt accepted meanwhile by
  // the original submit or a different API worker. Each write claims a revision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await prisma.aiRequest.findUnique({ where: { id: request.id } });
    const prior = current ? readJournal(current) : undefined;
    if (!current || !prior || current.userId !== request.userId) return { updated: false, journal };
    if (!['RESERVED', 'PROCESSING'].includes(current.status)
      || (prior.taskId && prior.taskId !== journal.taskId)) return { updated: false, journal: prior };
    const taskMetadata = mergeImageTaskMetadata(prior.taskMetadata, journal.taskMetadata);
    const merged = { ...journal,
      ...(prior.imageOperationContext || journal.imageOperationContext ? {
        imageOperationContext: { ...prior.imageOperationContext, ...journal.imageOperationContext } as ImageOperationContext,
      } : {}),
      ...(taskMetadata ? { taskMetadata } : {}),
    };
    const claimed = await prisma.aiRequest.updateMany({
      where: { id: request.id, userId: request.userId, result: { equals: current.result as Prisma.InputJsonObject },
        status: { in: ['RESERVED', 'PROCESSING'] } },
      data: { status: 'PROCESSING', result: toInputJson(merged) },
    });
    if (claimed.count === 1) return { updated: true, journal: merged };
  }
  const current = await prisma.aiRequest.findUnique({ where: { id: request.id } });
  return { updated: false, journal: current ? readJournal(current) ?? journal : journal };
}

function boundedStrings(value: unknown, maximum = 20): string[] {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value.slice(0, maximum) : [];
  return values.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= 32_000);
}

async function uploadUrls(value: unknown) {
  const output: string[] = [];
  for (const entry of boundedStrings(value, 5)) {
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) continue;
      await assertPublicProviderUrl(url.toString());
      output.push(url.toString());
    } catch { /* An unsafe uploaded URL is not a deliverable result. */ }
  }
  return output;
}

async function processSnapshot(
  prisma: PrismaClient, request: AiRequest, journal: OperationJournal,
  checked: ReturnType<typeof checkedRoute>, snapshot: unknown,
) {
  // Do not supply a known task ID to the shared normalizer: that fallback is
  // useful to older image protocols but cannot prove an operation's identity.
  const envelope = taskEnvelope(configuredImageTaskEnvelope(snapshot, checked.execution, ''), journal.taskId);
  if (!envelope) {
    const uncertain = { ...journal, status: 'uncertain' as const, errorCode: 'image_operation_identity_unconfirmed' };
    return publicResult((await saveJournal(prisma, request, uncertain)).journal);
  }
  const taskId = safeTaskId(envelope.task_id ?? envelope.taskId)!;
  const originalState = operationRecord(snapshot)?.status;
  const rawState = typeof originalState === 'string' && statuses.has(originalState.toLowerCase())
    ? originalState.toLowerCase() : typeof envelope.status === 'string' ? envelope.status.toLowerCase() : '';
  const state: WalletImageOperationStatus = statuses.has(rawState) ? rawState as WalletImageOperationStatus
    : checked.execution.completedStatuses.includes(rawState) ? 'success'
      : checked.execution.failedStatuses.includes(rawState) ? 'failed'
        : checked.execution.processingStatuses.includes(rawState) ? 'running' : 'uncertain';
  const taskMetadata = mergeImageTaskMetadata(journal.taskMetadata, extractImageTaskMetadata(envelope, taskId));
  if ((taskMetadata?.operation !== undefined && taskMetadata.operation !== journal.operation)
    || (taskMetadata?.speed !== undefined && taskMetadata.speed !== journal.speed)
    || (journal.imageOperationContext?.parentTaskId && taskMetadata?.parentTaskId !== undefined
      && taskMetadata.parentTaskId !== journal.imageOperationContext.parentTaskId)
    || (typeof envelope.model === 'string' && envelope.model !== journal.submittedModel)) {
    const uncertain = { ...journal, status: 'uncertain' as const, errorCode: 'image_operation_identity_unconfirmed' };
    return publicResult((await saveJournal(prisma, request, uncertain)).journal);
  }
  const milliseconds = Math.max(5_000, typeof envelope.poll_after_ms === 'number' && Number.isFinite(envelope.poll_after_ms)
    ? envelope.poll_after_ms : 5_000, imageRetryAfterMs(snapshot) ?? 0);
  const inherited = journal.imageOperationContext;
  const context: ImageOperationContext = {
    version: 1, protocol: 'GENERIC_TASK', providerId: checked.provider.id, routeId: checked.route.id,
    submittedModel: journal.submittedModel, operation: journal.operation, speed: journal.speed, taskId,
    providerConnectionFingerprint: journal.providerConnectionFingerprint,
    statusUrl: statusUrl(checked.provider, taskId, envelope.status_url, checked.execution.statusEndpointTemplate),
    ...(inherited?.originalImageDimensions ? { originalImageDimensions: inherited.originalImageDimensions } : {}),
    ...(inherited?.parentOperation ? { parentOperation: inherited.parentOperation } : {}),
    ...(inherited?.parentTaskId ? { parentTaskId: inherited.parentTaskId } : {}),
    ...(inherited?.parentClientRequestId ? { parentClientRequestId: inherited.parentClientRequestId } : {}),
  };
  let next: OperationJournal = { ...journal, taskId, status: state, imageOperationContext: context,
    nextRefreshAt: Date.now() + milliseconds, pollAfterMs: milliseconds,
    ...(taskMetadata ? { taskMetadata } : {}) };
  delete next.errorCode;
  // Save the accepted identity before downloading results or settling credits.
  const saved = await saveJournal(prisma, request, state === 'success' ? { ...next, status: 'running' } : next);
  if (!saved.updated) return publicResult(saved.journal);
  if (['failed', 'canceled', 'client_disconnected'].includes(state)) {
    next = { ...next, errorCode: 'image_operation_failed', chargedCredits: '0.000000' };
    await releaseOperationCredits(prisma, request.userId, request.id, journalJson(next));
    return canonicalResult(prisma, request.id, next);
  }
  if (state !== 'success') return publicResult(next);
  const midjourney = operationRecord(envelope.midjourney) ?? {};
  const texts = boundedStrings(midjourney.texts ?? midjourney.text);
  const uploadedUrls = await uploadUrls(midjourney.uploaded_urls);
  const requiresModal = taskMetadata?.requiresModal === true;
  if ((envelope.assets !== undefined && !Array.isArray(envelope.assets))
    || (Array.isArray(envelope.assets) && envelope.assets.length > 16)) {
    next = { ...next, status: 'uncertain', errorCode: Array.isArray(envelope.assets)
      ? 'image_operation_result_limit' : 'image_operation_result_unavailable' };
    return publicResult((await saveJournal(prisma, request, next)).journal);
  }
  const rawAssets = Array.isArray(envelope.assets) ? envelope.assets : [];
  const assetPaths: string[] = [];
  for (const candidate of rawAssets) {
    const asset = operationRecord(candidate);
    const path = asset?.download_url ?? asset?.url ?? asset?.signed_url;
    if (typeof path !== 'string' || !path || path.length > 8192) {
      next = { ...next, status: 'uncertain', errorCode: 'image_operation_result_unavailable' };
      return publicResult((await saveJournal(prisma, request, next)).journal);
    }
    if (!assetPaths.includes(path)) assetPaths.push(path);
  }
  const secrets = decryptProviderSecrets(checked.provider.encryptedSecrets);
  const sources: string[] = [];
  for (const path of assetPaths) {
    const content = await imageTaskResultContent(checked.provider, secrets, path, 30_000);
    if (typeof content !== 'string') failure('image_operation_result_unavailable', 'The result image is not yet available', 503);
    if (!sources.includes(content)) sources.push(content);
  }
  const images = await persistGeneratedImageResultsAndScheduleMirrors(sources, checked.provider.name, {
    clientRequestId: request.clientRequestId, canonicalModel: request.logicalModel,
    routeId: checked.route.id, providerId: checked.provider.id, adapterKey: 'GENERIC_OPENAI_IMAGE',
  });
  const delivered = ['describe', 'shorten'].includes(journal.operation) ? texts.length > 0
    : journal.operation === 'uploads' ? uploadedUrls.length > 0
      : ['inpaint', 'custom_zoom'].includes(journal.operation)
        ? requiresModal && taskMetadata?.actions.some(action => action.operation === 'modal') === true
        : images.length > 0;
  if (!delivered || images.length !== sources.length) {
    next = { ...next, status: 'uncertain', errorCode: 'image_operation_result_unavailable' };
    return publicResult((await saveJournal(prisma, request, next)).journal);
  }
  const imageDimensions = await imageOperationResultDimensions(images);
  const finalContext = { ...context,
    ...(imageDimensions ? { imageDimensions } : {}),
    ...(!context.originalImageDimensions && imageDimensions ? { originalImageDimensions: imageDimensions } : {}),
  };
  next = { ...next, images, texts, uploadedUrls, requiresModal, imageOperationContext: finalContext };
  await settleOperationCredits(prisma, request.userId, request.id, journalJson(next));
  const settled = await prisma.aiRequest.findUnique({ where: { id: request.id } });
  return publicResult(settled ? readJournal(settled) ?? next : next);
}

async function parentForOperation(prisma: PrismaClient, input: ImageOperationInput, canonicalModelId: string) {
  if (INITIAL_IMAGE_OPERATIONS.has(input.operation)) return undefined;
  const parent = await prisma.aiRequest.findUnique({ where: { userId_clientRequestId: {
    userId: input.userId, clientRequestId: input.parentClientRequestId!,
  } } });
  if (!parent || parent.userId !== input.userId || parent.capability !== 'IMAGE'
    || parent.status !== 'SUCCEEDED' || parent.canonicalModelId !== canonicalModelId) {
    failure('image_operation_parent_unavailable', 'The parent result is unavailable or not owned by this user');
  }
  const row = operationRecord(parent.result);
  const context = parseImageOperationContext(row?.imageOperationContext);
  const metadata = projectImageTaskMetadata(row?.taskMetadata);
  if (!context || !metadata || context.taskId !== metadata.taskId || parent.routeId !== context.routeId) {
    failure('image_operation_parent_context_missing', 'This parent does not have a verified operation context');
  }
  if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now()) failure('image_operation_parent_expired', 'The parent task has expired');
  const action = metadata.actions.find(candidate => candidate.actionId === input.actionId && candidate.operation === input.operation);
  if (!action) failure('image_operation_action_unavailable', 'The requested action was not returned by this parent');
  if (input.speed !== undefined && input.speed !== context.speed) operationValidationError('Parent operations must inherit their original speed');
  if (action.requiresPrompt && !input.prompt?.trim()) operationValidationError('This action requires a prompt');
  if (input.operation === 'modal') {
    if (!metadata.requiresModal || !['inpaint', 'custom_zoom'].includes(context.operation)) operationValidationError('Modal submission requires the new modal window task');
    if (!input.prompt?.trim()) operationValidationError('Modal submission requires a prompt');
    if (context.operation === 'inpaint') {
      if (input.zoom !== undefined || !input.maskBase64 || !context.originalImageDimensions) operationValidationError('Inpaint requires a mask matching the original result image');
      await validateImageOperationMask(input.maskBase64, context.originalImageDimensions);
    } else if (input.maskBase64 !== undefined || input.zoom === undefined) operationValidationError('Custom zoom requires a zoom factor from one to two and no mask');
  } else if (action.requiresMask && !['inpaint', 'custom_zoom'].includes(input.operation)) {
    operationValidationError('Masks must be submitted through the returned modal window');
  }
  return { parent, context, metadata };
}

export async function submitWalletImageOperation(prisma: PrismaClient, rawInput: ImageOperationInput): Promise<WalletImageOperationResult> {
  const input = imageOperationInputSchema.parse(rawInput);
  validateImageOperationInput(input);
  const requestFingerprint = fingerprint(input);
  const existing = await prisma.aiRequest.findUnique({ where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } } });
  if (existing) {
    const journal = readJournal(existing);
    if (!journal || journal.fingerprint !== requestFingerprint) failure('image_operation_id_conflict', 'This request ID already belongs to different parameters');
    return publicResult(journal);
  }
  const resolution = await resolveCatalogModel(prisma, input.model, 'image', { requireEnabled: true });
  if (!resolution) failure('image_operation_model_unavailable', 'The selected model is unavailable', 503);
  const parent = await parentForOperation(prisma, input, resolution.model.id);
  const selected = parent ? resolution.enabledRoutes.find(route => route.id === parent.context.routeId) : resolution.route;
  const checked = checkedRoute(selected);
  validateOperationCapabilities(input, resolution.model.capabilities, checked.route.capabilitiesOverride);
  if (parent && (parent.context.providerId !== checked.provider.id || parent.context.submittedModel !== checked.route.upstreamModelId
    || parent.context.providerConnectionFingerprint !== imageOperationProviderFingerprint(checked.provider))) {
    failure('image_operation_parent_route_changed', 'The original parent provider, model or account has changed');
  }
  const speed = parent?.context.speed ?? input.speed ?? checked.config.requestParameters?.speed;
  if (!isImageOperationSpeed(speed)) operationValidationError('A configured or explicit operation speed is required');
  const sources = await resolveReferenceImageSources(prisma, input.userId, input.inputImages ?? []);
  const references: string[] = [];
  for (const source of sources) references.push((await prepareGenericImageDataUrlReference(source)).value);
  const body: Record<string, unknown> = {
    model: checked.route.upstreamModelId, operation: input.operation, speed, n: 1,
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(references.length ? { images: references.map(image_url => ({ image_url })) } : {}),
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.dimensions ? { dimensions: input.dimensions } : {}),
    ...(parent ? { parent_task_id: parent.context.taskId, action_id: input.actionId } : {}),
    ...(input.zoom !== undefined ? { zoom: input.zoom } : {}),
    ...(input.maskBase64 ? { mask_base64: input.maskBase64 } : {}),
  };
  if (typeof checked.config.async === 'boolean') body.async = checked.config.async;
  if (checked.execution.asyncParameterName) {
    const key = checked.execution.asyncParameterName;
    if (Object.hasOwn(body, key) && key !== 'async') failure('image_operation_route_invalid', 'The async parameter conflicts with an operation field');
    body[key] = checked.execution.asyncParameterValue;
  }
  const headers = genericImageRequestHeaders(checked.provider, input, {
    routeId: checked.route.id, adapterKey: checked.route.adapterKey, adapterConfig: checked.route.adapterConfig,
  })!;
  const secrets = decryptProviderSecrets(checked.provider.encryptedSecrets);
  const snapshot = await capturePricingSnapshot(prisma, resolution.model, checked.route.id, { operation: input.operation, speed, count: 1 }, input.userId);
  await assertPublicProviderUrl(checked.provider.baseUrl);
  const journal: OperationJournal = {
    imageOperationVersion: 1, fingerprint: requestFingerprint, clientRequestId: input.clientRequestId,
    status: 'queued', operation: input.operation, speed, images: [], texts: [], uploadedUrls: [], requiresModal: false,
    chargedCredits: '0.000000', providerId: checked.provider.id, routeId: checked.route.id,
    submittedModel: checked.route.upstreamModelId, providerConnectionFingerprint: imageOperationProviderFingerprint(checked.provider),
    receiptKey: headers['Idempotency-Key'], nextRefreshAt: Date.now() + 5_000,
    ...(parent ? { imageOperationContext: { ...parent.context, operation: input.operation, taskId: '',
      parentOperation: parent.context.operation,
      parentTaskId: parent.context.taskId, parentClientRequestId: input.parentClientRequestId!,
      ...(parent.context.imageDimensions ? { originalImageDimensions: parent.context.imageDimensions } : {}),
    } } : {}),
  };
  const reservation = await reserveOperationCredits(prisma, input, snapshot, journalJson(journal));
  if (!reservation.created) {
    const prior = readJournal(reservation.request);
    if (!prior || prior.fingerprint !== requestFingerprint) failure('image_operation_id_conflict', 'This request ID already belongs to different parameters');
    return publicResult(prior);
  }
  await saveJournal(prisma, reservation.request, journal);
  let responseReceived = false;
  try {
    const response = await providerRequest(checked.provider, secrets,
      '/v1/images/generations', body, checked.execution.submitTimeoutMs, headers);
    responseReceived = true;
    return await processSnapshot(prisma, reservation.request, journal, checked, response);
  } catch (error) {
    const httpStatus = imageReadHttpStatus(error);
    const saved = await prisma.aiRequest.findUnique({ where: { id: reservation.request.id } });
    const prior = saved ? readJournal(saved) : undefined;
    if (!responseReceived && !prior?.taskId && httpStatus !== null && [400, 401, 403, 404, 422].includes(httpStatus)) {
      const failed = { ...journal, status: 'failed' as const, errorCode: 'image_operation_rejected' };
      try {
        await releaseOperationCredits(prisma, input.userId, reservation.request.id, journalJson(failed));
        return canonicalResult(prisma, reservation.request.id, failed);
      } catch (releaseError) {
        if (!(releaseError instanceof CloudAiError) || releaseError.code !== 'image_operation_identity_mismatch') throw releaseError;
        // A concurrent GET accepted a receipt between the read and refund CAS.
        // Return that authoritative receipt without erasing it or resubmitting.
        return canonicalResult(prisma, reservation.request.id, { ...journal, status: 'uncertain',
          errorCode: 'image_operation_result_unconfirmed' });
      }
    }
    if (saved?.status === 'SUCCEEDED' && readJournal(saved)) return publicResult(readJournal(saved)!);
    const uncertain = { ...(prior ?? journal), status: 'uncertain' as const,
      errorCode: 'image_operation_result_unconfirmed' };
    return publicResult((await saveJournal(prisma, reservation.request, uncertain)).journal);
  }
}

async function refreshOperation(prisma: PrismaClient, request: AiRequest, journal: OperationJournal) {
  const route = await prisma.aiModelRoute.findUnique({ where: { id: journal.routeId }, include: { channel: true } });
  const checked = checkedRoute(route);
  if (checked.provider.id !== journal.providerId || checked.route.upstreamModelId !== journal.submittedModel
    || imageOperationProviderFingerprint(checked.provider) !== journal.providerConnectionFingerprint) {
    failure('image_operation_parent_route_changed', 'The original operation provider, model or account has changed');
  }
  await assertPublicProviderUrl(checked.provider.baseUrl);
  const secrets = decryptProviderSecrets(checked.provider.encryptedSecrets);
  // Reserve the read window before network access. Refresh never creates a task.
  const nextRefreshAt = Date.now() + 5_000;
  const claim = await prisma.aiRequest.updateMany({
    where: { id: request.id, userId: request.userId, result: { equals: request.result as Prisma.InputJsonObject },
      status: { in: ['RESERVED', 'PROCESSING'] } },
    data: { result: toInputJson({ ...journal, nextRefreshAt }) },
  });
  if (claim.count !== 1) {
    const current = await prisma.aiRequest.findUnique({ where: { id: request.id } });
    return publicResult(current ? readJournal(current) ?? journal : journal);
  }
  try {
    let snapshot: unknown;
    if (journal.taskId) {
      const path = statusUrl(checked.provider, journal.taskId, journal.imageOperationContext?.statusUrl, checked.execution.statusEndpointTemplate);
      snapshot = await providerRequest(checked.provider, secrets, path, undefined, 15_000);
    } else {
      const list = await providerRequest(checked.provider, secrets, '/v1/images/tasks?limit=100', undefined, 15_000);
      const row = operationRecord(list);
      const tasks = Array.isArray(row?.data) ? row.data : Array.isArray(row?.tasks) ? row.tasks : [];
      snapshot = tasks.slice(0, 100).find(candidate => operationRecord(candidate)?.client_request_id === journal.receiptKey);
    }
    return await processSnapshot(prisma, request, { ...journal, nextRefreshAt }, checked, snapshot);
  } catch {
    const saved = await prisma.aiRequest.findUnique({ where: { id: request.id } });
    if (saved?.status === 'SUCCEEDED' && readJournal(saved)) return publicResult(readJournal(saved)!);
    const uncertain = { ...(saved ? readJournal(saved) ?? journal : journal), status: 'uncertain' as const,
      nextRefreshAt, errorCode: 'image_operation_result_unconfirmed' };
    return publicResult((await saveJournal(prisma, request, uncertain)).journal);
  }
}

export async function getWalletImageOperation(
  prisma: PrismaClient, userId: string, clientRequestId: string, options: { refresh?: boolean } = {},
): Promise<WalletImageOperationResult | null> {
  const request = await prisma.aiRequest.findUnique({ where: { userId_clientRequestId: { userId, clientRequestId } } });
  if (!request || request.userId !== userId || request.capability !== 'IMAGE') return null;
  const journal = readJournal(request);
  if (!journal) return null;
  if (!options.refresh || terminal.has(journal.status) || journal.nextRefreshAt > Date.now()) return publicResult(journal);
  const key = `${userId}:${request.id}`;
  const existing = refreshes.get(key);
  if (existing) return existing;
  const pending = refreshOperation(prisma, request, journal);
  refreshes.set(key, pending);
  try { return await pending; } finally { refreshes.delete(key); }
}
