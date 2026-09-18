import { genericAsyncVideoAdapter } from './generic-async-video.js';
import { legacyVideoAdapter } from './legacy-video.js';
import type { VideoAdapter } from './types.js';

const adapters = new Map<string, VideoAdapter>([
  [genericAsyncVideoAdapter.key, genericAsyncVideoAdapter],
  ['AI_MEDIA_VIDEOS_API', genericAsyncVideoAdapter],
  [legacyVideoAdapter.key, legacyVideoAdapter],
  // Existing adapters are retained as explicit compatibility protocols until
  // their provider-specific implementations are extracted from legacy code.
  ['MINIMAX_NATIVE_VIDEO', legacyVideoAdapter],
  ['SEEDANCE_VIDEO', legacyVideoAdapter],
  ['VEO_VIDEO', legacyVideoAdapter],
  ['KLING_VIDEO', legacyVideoAdapter],
  ['OPENAI_COMPATIBLE_VIDEO', legacyVideoAdapter],
]);

export const getVideoAdapter = (adapterKey?: string | null) => (
  adapterKey ? adapters.get(adapterKey.trim().toUpperCase()) : undefined
);

export const isVideoAdapterReady = (
  adapterKey: string | null | undefined,
  context: Parameters<VideoAdapter['canHandleRequest']>[0],
  request: Parameters<VideoAdapter['canHandleRequest']>[1],
) => Boolean(getVideoAdapter(adapterKey)?.canHandleRequest(context, request));
