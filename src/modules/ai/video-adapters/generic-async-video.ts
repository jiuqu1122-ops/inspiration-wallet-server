import { decryptProviderSecrets } from '../../../lib/provider-secrets.js';
import { assertPublicProviderUrl, providerEndpoint } from '../../providers/url.js';
import type {
  VideoAdapter,
  VideoAdapterContext,
  VideoAdapterPollResult,
} from './types.js';

export type GenericAsyncVideoConfig = {
  submitEndpoint: string;
  statusEndpointTemplate: string;
  contentEndpointTemplate: string;
  modelParameter: string;
  promptParameter: string;
  durationParameter: 'none' | 'seconds' | 'duration';
  resolutionParameter: 'none' | 'size' | 'resolution';
  aspectRatioParameter: 'none' | 'aspect_ratio' | 'ratio';
  referenceImagesParameter?: string;
  referenceVideosParameter?: string;
  referenceAudiosParameter?: string;
  referenceSerialization?: 'array';
  taskIdPath: string;
  statusPath: string;
  videoAvailablePath: string;
  assetStatePath: string;
  pollAfterMsPath: string;
  processingStatuses: string[];
  completedStatuses: string[];
  failedStatuses: string[];
  requiresVideoAvailable: boolean;
  idempotencyHeader: string;
};

const objectValue = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};
const textValue = (value: unknown, fallback: string) => typeof value === 'string' && value.trim()
  ? value.trim()
  : fallback;
const listValue = (value: unknown, fallback: string[]) => Array.isArray(value)
  ? value.map(String).map(item => item.trim().toLowerCase()).filter(Boolean)
  : fallback;
const parameterMode = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (
  typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback
);

export function normalizeGenericAsyncVideoConfig(value: unknown): GenericAsyncVideoConfig {
  const source = objectValue(value);
  const optionalParameter = (key: string) => {
    const parameter = typeof source[key] === 'string' ? source[key].trim() : '';
    return parameter || undefined;
  };
  const referenceImagesParameter = optionalParameter('referenceImagesParameter');
  const referenceVideosParameter = optionalParameter('referenceVideosParameter');
  const referenceAudiosParameter = optionalParameter('referenceAudiosParameter');
  return {
    submitEndpoint: textValue(source.submitEndpoint, '/v1/videos'),
    statusEndpointTemplate: textValue(source.statusEndpointTemplate, '/v1/videos/{taskId}'),
    contentEndpointTemplate: textValue(source.contentEndpointTemplate, '/v1/videos/{taskId}/content'),
    modelParameter: textValue(source.modelParameter, 'model'),
    promptParameter: textValue(source.promptParameter, 'prompt'),
    durationParameter: parameterMode(source.durationParameter, ['none', 'seconds', 'duration'] as const, 'seconds'),
    resolutionParameter: parameterMode(source.resolutionParameter, ['none', 'size', 'resolution'] as const, 'none'),
    aspectRatioParameter: parameterMode(source.aspectRatioParameter, ['none', 'aspect_ratio', 'ratio'] as const, 'none'),
    ...(referenceImagesParameter ? { referenceImagesParameter } : {}),
    ...(referenceVideosParameter ? { referenceVideosParameter } : {}),
    ...(referenceAudiosParameter ? { referenceAudiosParameter } : {}),
    ...(source.referenceSerialization === 'array' ? { referenceSerialization: 'array' as const } : {}),
    taskIdPath: textValue(source.taskIdPath, 'id'),
    statusPath: textValue(source.statusPath, 'status'),
    videoAvailablePath: textValue(source.videoAvailablePath, 'video_available'),
    assetStatePath: textValue(source.assetStatePath, 'asset_state'),
    pollAfterMsPath: textValue(source.pollAfterMsPath, 'poll_after_ms'),
    processingStatuses: listValue(source.processingStatuses, ['queued', 'in_progress', 'pending_confirmation']),
    completedStatuses: listValue(source.completedStatuses, ['completed']),
    failedStatuses: listValue(source.failedStatuses, ['failed']),
    requiresVideoAvailable: source.requiresVideoAvailable !== false,
    idempotencyHeader: textValue(source.idempotencyHeader, 'Idempotency-Key'),
  };
}

export function validateGenericAsyncVideoConfig(value: unknown) {
  const source = objectValue(value);
  if (source.referenceSerialization !== undefined && source.referenceSerialization !== 'array') {
    throw new Error('referenceSerialization must be array');
  }
  const config = normalizeGenericAsyncVideoConfig(value);
  if (!config.statusEndpointTemplate.includes('{taskId}')
    || !config.contentEndpointTemplate.includes('{taskId}')) {
    throw new Error('Video status and content endpoint templates must contain {taskId}');
  }
  if (config.processingStatuses.length === 0
    || config.completedStatuses.length === 0
    || config.failedStatuses.length === 0) {
    throw new Error('Video adapter status lists must not be empty');
  }
  if ((config.referenceImagesParameter || config.referenceVideosParameter || config.referenceAudiosParameter)
    && config.referenceSerialization !== 'array') {
    throw new Error('Reference parameters require referenceSerialization=array');
  }
  return config;
}

const pathValue = (value: unknown, path: string): unknown => path.split('.').filter(Boolean).reduce<unknown>(
  (current, segment) => current && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)[segment]
    : undefined,
  value,
);

const scalarText = (value: unknown) => typeof value === 'string' || typeof value === 'number'
  ? String(value).trim()
  : '';

const requestHeaders = (context: VideoAdapterContext, extra?: Record<string, string>) => {
  const secrets = decryptProviderSecrets(context.provider.encryptedSecrets);
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${secrets.apiKey}`,
    ...secrets.headers,
    ...extra,
  };
};

const endpoint = (context: VideoAdapterContext, template: string, taskId?: string) => providerEndpoint(
  context.provider.baseUrl,
  taskId === undefined ? template : template.replaceAll('{taskId}', encodeURIComponent(taskId)),
);

async function jsonRequest(
  context: VideoAdapterContext,
  path: string,
  init: RequestInit,
) {
  await assertPublicProviderUrl(context.provider.baseUrl);
  const response = await fetch(endpoint(context, path), init);
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
  if (!response.ok) {
    const error = new Error(`Video provider request failed with HTTP ${response.status}`) as Error & {
      status?: number;
      retryAfterMs?: number;
      payload?: unknown;
    };
    error.status = response.status;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const date = Date.parse(retryAfter);
      const retryAfterMs = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1_000)
        : Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
      if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
    }
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const genericAsyncVideoAdapter: VideoAdapter = {
  key: 'GENERIC_ASYNC_VIDEO',
  executionMode: 'async-task',
  canHandleRequest(context, request) {
    const config = normalizeGenericAsyncVideoConfig(context.route.adapterConfig);
    if (request.inputImages.length > 0
      && (!config.referenceImagesParameter || config.referenceSerialization !== 'array')) return false;
    if (request.inputVideos.length > 0
      && (!config.referenceVideosParameter || config.referenceSerialization !== 'array')) return false;
    if (request.inputAudios.length > 0
      && (!config.referenceAudiosParameter || config.referenceSerialization !== 'array')) return false;
    return Boolean(context.route.upstreamModelId.trim());
  },
  async submit(context, request, _outputIndex, idempotencyKey) {
    const config = normalizeGenericAsyncVideoConfig(context.route.adapterConfig);
    if (!this.canHandleRequest(context, request)) {
      throw new Error('Generic video adapter cannot serialize every requested reference input');
    }
    const body: Record<string, unknown> = {
      [config.modelParameter]: context.route.upstreamModelId,
      [config.promptParameter]: request.prompt,
    };
    if (request.duration !== undefined && config.durationParameter !== 'none') body[config.durationParameter] = request.duration;
    if (request.resolution && config.resolutionParameter !== 'none') body[config.resolutionParameter] = request.resolution;
    if (request.aspectRatio && config.aspectRatioParameter !== 'none') body[config.aspectRatioParameter] = request.aspectRatio;
    if (request.inputImages.length > 0 && config.referenceImagesParameter) body[config.referenceImagesParameter] = request.inputImages;
    if (request.inputVideos.length > 0 && config.referenceVideosParameter) body[config.referenceVideosParameter] = request.inputVideos;
    if (request.inputAudios.length > 0 && config.referenceAudiosParameter) body[config.referenceAudiosParameter] = request.inputAudios;
    const payload = await jsonRequest(context, config.submitEndpoint, {
      method: 'POST',
      headers: requestHeaders(context, { [config.idempotencyHeader]: idempotencyKey }),
      body: JSON.stringify(body),
    });
    const upstreamTaskId = scalarText(pathValue(payload, config.taskIdPath));
    if (!upstreamTaskId) throw new Error(`Video provider response is missing ${config.taskIdPath}`);
    const pollAfter = Number(pathValue(payload, config.pollAfterMsPath));
    return {
      upstreamTaskId,
      upstreamPayload: payload,
      ...(Number.isFinite(pollAfter) && pollAfter >= 0 ? { pollAfterMs: pollAfter } : {}),
    };
  },
  async poll(context, upstreamTaskId) {
    const config = normalizeGenericAsyncVideoConfig(context.route.adapterConfig);
    let payload: unknown;
    try {
      payload = await jsonRequest(
        context,
        config.statusEndpointTemplate.replaceAll('{taskId}', encodeURIComponent(upstreamTaskId)),
        { method: 'GET', headers: requestHeaders(context) },
      );
    } catch (error) {
      const typed = error as Error & { status?: number; retryAfterMs?: number; payload?: unknown };
      if (typed.status === 429) {
        return {
          state: 'processing',
          upstreamStatus: 'rate_limited',
          upstreamPayload: typed.payload ?? null,
          ...(typed.retryAfterMs !== undefined ? { pollAfterMs: typed.retryAfterMs } : {}),
        } satisfies VideoAdapterPollResult;
      }
      throw error;
    }
    const status = scalarText(pathValue(payload, config.statusPath)).toLowerCase();
    const videoAvailableValue = pathValue(payload, config.videoAvailablePath);
    const videoAvailable = typeof videoAvailableValue === 'boolean' ? videoAvailableValue : undefined;
    const assetStateValue = pathValue(payload, config.assetStatePath);
    const assetState = typeof assetStateValue === 'string' ? assetStateValue.trim().toLowerCase() : undefined;
    const pollAfterValue = Number(pathValue(payload, config.pollAfterMsPath));
    const common = {
      upstreamStatus: status || 'unknown',
      upstreamPayload: payload,
      ...(videoAvailable !== undefined ? { videoAvailable } : {}),
      ...(assetState ? { assetState } : {}),
      ...(Number.isFinite(pollAfterValue) && pollAfterValue >= 0 ? { pollAfterMs: pollAfterValue } : {}),
    };
    if (assetState === 'expired') return { state: 'failed', error: 'Video asset expired', ...common };
    if (config.failedStatuses.includes(status)) return { state: 'failed', error: `Video task failed: ${status}`, ...common };
    if (config.completedStatuses.includes(status)) {
      if (config.requiresVideoAvailable && videoAvailable !== true) return { state: 'processing', ...common };
      if (assetState === 'saving' || assetState === 'failed') return { state: 'processing', ...common };
      return { state: 'completed', ...common };
    }
    return { state: 'processing', ...common };
  },
  async fetchContent(context, upstreamTaskId) {
    const config = normalizeGenericAsyncVideoConfig(context.route.adapterConfig);
    return {
      source: endpoint(context, config.contentEndpointTemplate, upstreamTaskId),
      requestHeaders: requestHeaders(context),
    };
  },
};
