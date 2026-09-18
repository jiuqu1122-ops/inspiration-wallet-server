import { getVideoAdapter } from './video-adapters/registry.js';
import type { VideoAdapterProvider, VideoAdapterRoute } from './video-adapters/types.js';
import { videoCapabilitiesSupportRequest } from './video-capabilities.js';
import type { NormalizedVideoRequest } from './video-request.js';

export type VideoRouteCandidate = VideoAdapterRoute & {
  channelId: string | null;
  enabled: boolean;
  upstreamAvailable: boolean;
  healthStatus: string;
  priority: number;
  channel: (VideoAdapterProvider & { status: string }) | null;
};

const unavailableHealth = new Set(['UNAVAILABLE', 'UNHEALTHY', 'DOWN', 'FAILED', 'DISABLED']);

export function routeSupportsManagedVideoRequest(
  route: VideoRouteCandidate,
  canonicalCapabilities: unknown,
  request: NormalizedVideoRequest,
) {
  if (!route.enabled || !route.upstreamAvailable || !route.channel || route.channel.status !== 'ACTIVE') return false;
  if (unavailableHealth.has(route.healthStatus.trim().toUpperCase())) return false;
  if (!route.canonicalModelId || !route.adapterKey || !route.upstreamModelId.trim()) return false;
  const effectiveCapabilities = route.capabilitiesOverride ?? canonicalCapabilities;
  if (!videoCapabilitiesSupportRequest(effectiveCapabilities, request)) return false;
  const adapter = getVideoAdapter(route.adapterKey);
  return Boolean(adapter?.canHandleRequest({ route, provider: route.channel }, request));
}

export function selectManagedVideoRoutes(
  routes: readonly VideoRouteCandidate[],
  canonicalModelId: string,
  canonicalCapabilities: unknown,
  request: NormalizedVideoRequest,
  defaultRouteId?: string | null,
) {
  return routes
    .filter(route => route.canonicalModelId === canonicalModelId)
    .filter(route => routeSupportsManagedVideoRequest(route, canonicalCapabilities, request))
    .sort((left, right) => {
      const leftDefault = left.id === defaultRouteId ? 0 : 1;
      const rightDefault = right.id === defaultRouteId ? 0 : 1;
      return leftDefault - rightDefault || left.priority - right.priority || left.id.localeCompare(right.id);
    });
}
