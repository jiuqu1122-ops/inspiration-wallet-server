import { genericOpenAiImageAdapter } from './generic-openai-image.js';
import { geminiNativeImageAdapter } from './gemini-native.js';
import { gptImageAdapter } from './gpt-image.js';
import { grokImagesApiAdapter } from './grok.js';
import { nanoBananaAdapter } from './nano-banana.js';
import { seedreamImagesApiAdapter } from './seedream.js';
import {
  IMAGE_ADAPTER_KEYS,
  ImageAdapterError,
  assertPreparedImageIdentity,
  type ImageAdapterInput,
  type ImageAdapterKey,
  type ImageModelAdapter,
  type PreparedImageAdapterRequest,
} from './types.js';

const legacyAdapter: ImageModelAdapter = { key: 'LEGACY', execution: 'legacy' };

const adapters = new Map<ImageAdapterKey, ImageModelAdapter>([
  ['LEGACY', legacyAdapter],
  ['GPT_IMAGE', gptImageAdapter],
  ['NANO_BANANA', nanoBananaAdapter],
  ['GEMINI_NATIVE_IMAGE', geminiNativeImageAdapter],
  ['SEEDREAM_IMAGES_API', seedreamImagesApiAdapter],
  ['GROK_IMAGES_API', grokImagesApiAdapter],
  ['GENERIC_OPENAI_IMAGE', genericOpenAiImageAdapter],
]);

export function isImageAdapterKey(value: unknown): value is ImageAdapterKey {
  return typeof value === 'string' && (IMAGE_ADAPTER_KEYS as readonly string[]).includes(value);
}

export function getImageModelAdapter(value: string | null | undefined) {
  const key = value?.trim() || 'LEGACY';
  if (!isImageAdapterKey(key)) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      `Unknown image adapter key: ${key}`,
    );
  }
  return adapters.get(key)!;
}

export function prepareImageAdapterRequest(
  adapter: ImageModelAdapter,
  input: ImageAdapterInput,
): PreparedImageAdapterRequest | null {
  adapter.validateModel?.(input.upstreamModel);
  if (adapter.execution === 'legacy') return null;
  if (!adapter.buildRequest) {
    throw new ImageAdapterError(
      'IMAGE_ADAPTER_CONFIG_INVALID',
      `Image adapter ${adapter.key} has no request builder`,
    );
  }
  const prepared = adapter.buildRequest(input);
  assertPreparedImageIdentity(input, prepared);
  return prepared;
}

export { IMAGE_ADAPTER_KEYS } from './types.js';
export type {
  ImageAdapterConfig,
  ImageAdapterInput,
  ImageAdapterKey,
  ImageModelAdapter,
  PreparedImageAdapterRequest,
} from './types.js';
export { ImageAdapterError, assertPreparedImageIdentity } from './types.js';
