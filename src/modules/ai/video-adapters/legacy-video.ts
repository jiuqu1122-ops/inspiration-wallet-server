import type { VideoAdapter } from './types.js';

/**
 * Existing provider-specific video protocols remain available only through
 * the legacy execution path in image-service. It is intentionally not used
 * for a managed route unless the route explicitly selects LEGACY_VIDEO.
 */
export const legacyVideoAdapter: VideoAdapter = {
  key: 'LEGACY_VIDEO',
  executionMode: 'legacy-delegate',
  canHandleRequest(context) {
    return Boolean(context.route.upstreamModelId.trim());
  },
  async submit() {
    throw new Error('LEGACY_VIDEO submissions are delegated to the legacy video executor');
  },
  async poll() {
    throw new Error('LEGACY_VIDEO polling is delegated to the legacy video executor');
  },
  async fetchContent() {
    throw new Error('LEGACY_VIDEO content is delegated to the legacy video executor');
  },
};
