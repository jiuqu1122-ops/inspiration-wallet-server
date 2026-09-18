import type { NormalizedVideoRequest } from '../video-request.js';

export type VideoAdapterRoute = {
  id: string;
  canonicalModelId: string | null;
  upstreamModelId: string;
  adapterKey: string | null;
  adapterConfig: unknown;
  capabilitiesOverride?: unknown;
};

export type VideoAdapterProvider = {
  id: string;
  name: string;
  baseUrl: string;
  encryptedSecrets: string;
};

export type VideoAdapterSubmission = {
  upstreamTaskId: string;
  upstreamPayload: unknown;
  pollAfterMs?: number;
};

export type VideoAdapterPollResult = {
  state: 'processing' | 'completed' | 'failed';
  upstreamStatus: string;
  videoAvailable?: boolean;
  assetState?: string;
  pollAfterMs?: number;
  contentSource?: string;
  upstreamPayload: unknown;
  error?: string;
};

export type VideoAdapterContext = {
  route: VideoAdapterRoute;
  provider: VideoAdapterProvider;
};

export interface VideoAdapter {
  readonly key: string;
  readonly executionMode: 'async-task' | 'legacy-delegate';
  canHandleRequest(context: VideoAdapterContext, request: NormalizedVideoRequest): boolean;
  submit(
    context: VideoAdapterContext,
    request: NormalizedVideoRequest,
    outputIndex: number,
    idempotencyKey: string,
  ): Promise<VideoAdapterSubmission>;
  poll(context: VideoAdapterContext, upstreamTaskId: string): Promise<VideoAdapterPollResult>;
  fetchContent(context: VideoAdapterContext, upstreamTaskId: string, status: VideoAdapterPollResult): Promise<{
    source: string;
    requestHeaders?: Record<string, string>;
  }>;
}
