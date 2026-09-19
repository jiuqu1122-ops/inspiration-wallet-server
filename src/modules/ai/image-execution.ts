import { ImageAdapterError } from './image-adapters/types.js';

export const IMAGE_ADAPTER_SUBMIT_TIMEOUT_MS = 60_000;

export type ImageRouteExecutionMode = 'INHERIT' | 'DIRECT' | 'TASK';

export type ImageTaskExecutionProfile = 'USELG_IMAGE_TASK' | 'GENERIC_TASK';

export type ImageTaskExecutionConfig = {
  profile: ImageTaskExecutionProfile;
  submitEndpoint: string;
  statusEndpointTemplate?: string;
  resultEndpointTemplate?: string;
  taskIdPath: string;
  statusPath: string;
  pollAfterMsPath: string;
  processingStatuses: string[];
  completedStatuses: string[];
  failedStatuses: string[];
  assetArrayPath: string;
  signedUrlPath: string;
  downloadUrlPath: string;
  urlPath: string;
  submitTimeoutMs: number;
  asyncParameterName?: string;
  asyncParameterValue?: unknown;
};

const USELG_IMAGE_TASK_PROFILE = {
  statusEndpointTemplate: '/v1/images/tasks/{taskId}?view=summary',
  taskIdPath: 'task_id',
  statusPath: 'status',
  pollAfterMsPath: 'poll_after_ms',
  processingStatuses: ['queued', 'pending', 'processing', 'in_progress'],
  completedStatuses: ['success', 'succeeded', 'completed', 'done', 'finished'],
  failedStatuses: ['failed', 'failure', 'error', 'cancelled', 'canceled'],
  assetArrayPath: 'assets',
  signedUrlPath: 'signed_url',
  downloadUrlPath: 'download_url',
  urlPath: 'url',
  submitTimeoutMs: IMAGE_ADAPTER_SUBMIT_TIMEOUT_MS,
} as const;

const GENERIC_IMAGE_TASK_PROFILE = {
  taskIdPath: 'task_id',
  statusPath: 'status',
  pollAfterMsPath: 'poll_after_ms',
  processingStatuses: ['queued', 'pending', 'processing', 'in_progress'],
  completedStatuses: ['success', 'succeeded', 'completed', 'done', 'finished'],
  failedStatuses: ['failed', 'failure', 'error', 'cancelled', 'canceled'],
  assetArrayPath: 'assets',
  signedUrlPath: 'signed_url',
  downloadUrlPath: 'download_url',
  urlPath: 'url',
  submitTimeoutMs: IMAGE_ADAPTER_SUBMIT_TIMEOUT_MS,
} as const;

export function imageRouteExecutionMode(value: unknown): ImageRouteExecutionMode {
  return value === 'DIRECT' || value === 'TASK' ? value : 'INHERIT';
}

function executionConfigRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function executionStringArray(value: unknown, fallback: readonly string[]) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)
    || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'Image task status lists must contain non-empty strings',
    );
  }
  return Array.from(new Set(value.map(item => String(item).trim().toLowerCase())));
}

function executionString(
  source: Record<string, unknown>,
  key: string,
  fallback?: string,
) {
  const value = source[key] ?? fallback;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      `Image task ${key} must be a non-empty string`,
    );
  }
  return value.trim();
}

export function normalizeImageTaskExecutionConfig(value: unknown): ImageTaskExecutionConfig {
  const source = executionConfigRecord(value);
  const profile = source.profile;
  if (profile !== 'USELG_IMAGE_TASK' && profile !== 'GENERIC_TASK') {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'TASK execution requires a confirmed USELG_IMAGE_TASK or GENERIC_TASK profile',
    );
  }
  const preset = profile === 'USELG_IMAGE_TASK'
    ? USELG_IMAGE_TASK_PROFILE
    : GENERIC_IMAGE_TASK_PROFILE;
  const submitEndpoint = executionString(source, 'submitEndpoint');
  if (!submitEndpoint?.startsWith('/') || submitEndpoint.startsWith('//')) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'TASK execution requires an absolute provider submitEndpoint',
    );
  }
  if (/:generateContent(?:\?|$)/i.test(submitEndpoint)) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'Gemini generateContent is not a confirmed fast task submit endpoint; TASK execution requires a real task contract',
    );
  }
  const submitTimeoutMs = source.submitTimeoutMs === undefined
    ? preset.submitTimeoutMs
    : Number(source.submitTimeoutMs);
  if (!Number.isInteger(submitTimeoutMs)
    || submitTimeoutMs < 45_000
    || submitTimeoutMs > 90_000) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'Image task submitTimeoutMs must be an integer between 45000 and 90000',
    );
  }
  const asyncParameterName = executionString(source, 'asyncParameterName');
  if (asyncParameterName && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(asyncParameterName)) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'Image task asyncParameterName is invalid',
    );
  }
  if (!asyncParameterName && source.asyncParameterValue !== undefined) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'asyncParameterValue requires asyncParameterName',
    );
  }

  const presetStatusEndpoint = profile === 'USELG_IMAGE_TASK'
    ? USELG_IMAGE_TASK_PROFILE.statusEndpointTemplate
    : undefined;
  const statusEndpointTemplate = executionString(
    source,
    'statusEndpointTemplate',
    presetStatusEndpoint,
  );
  const resultEndpointTemplate = executionString(source, 'resultEndpointTemplate');

  if (!statusEndpointTemplate && !resultEndpointTemplate) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      'TASK execution requires a statusEndpointTemplate or resultEndpointTemplate',
    );
  }

  return {
    profile,
    submitEndpoint,
    ...(statusEndpointTemplate ? { statusEndpointTemplate } : {}),
    ...(resultEndpointTemplate ? { resultEndpointTemplate } : {}),
    taskIdPath: executionString(source, 'taskIdPath', preset.taskIdPath)!,
    statusPath: executionString(source, 'statusPath', preset.statusPath)!,
    pollAfterMsPath: executionString(source, 'pollAfterMsPath', preset.pollAfterMsPath)!,
    processingStatuses: executionStringArray(source.processingStatuses, preset.processingStatuses),
    completedStatuses: executionStringArray(source.completedStatuses, preset.completedStatuses),
    failedStatuses: executionStringArray(source.failedStatuses, preset.failedStatuses),
    assetArrayPath: executionString(source, 'assetArrayPath', preset.assetArrayPath)!,
    signedUrlPath: executionString(source, 'signedUrlPath', preset.signedUrlPath)!,
    downloadUrlPath: executionString(source, 'downloadUrlPath', preset.downloadUrlPath)!,
    urlPath: executionString(source, 'urlPath', preset.urlPath)!,
    submitTimeoutMs,
    ...(asyncParameterName ? {
      asyncParameterName,
      asyncParameterValue: source.asyncParameterValue ?? true,
    } : {}),
  };
}
