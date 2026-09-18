import {
  isValidAspectRatio,
  resolveVideoCapabilities,
  videoAspectRatioAllowed,
  videoCapabilitiesSupportRequest,
  videoDurationAllowed,
} from './video-capabilities.js';

export type RawManagedVideoRequest = {
  model: string;
  prompt: string;
  resolution?: string | undefined;
  duration?: number | undefined;
  aspectRatio?: string | undefined;
  inputImages: string[];
  inputVideos: string[];
  inputAudios: string[];
  inputMode?: 'REF' | 'FLF' | undefined;
  count: number;
};

export type NormalizedVideoRequest = Omit<RawManagedVideoRequest, 'model' | 'resolution' | 'duration' | 'aspectRatio' | 'inputMode'> & {
  canonicalModelKey: string;
  resolution?: string;
  duration?: number;
  aspectRatio?: string;
  inputMode: 'REF' | 'FLF';
};

export class ManagedVideoRequestError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'ManagedVideoRequestError';
  }
}

function defaultDuration(capabilities: ReturnType<typeof resolveVideoCapabilities>) {
  if (capabilities.defaultDurationSeconds !== undefined) return capabilities.defaultDurationSeconds;
  if (capabilities.durationMode === 'fixed' && capabilities.durations.length === 1) return capabilities.durations[0];
  if ((capabilities.durationMode === 'list' || !capabilities.durationMode) && capabilities.durations.length > 0) {
    return capabilities.durations[0];
  }
  if (capabilities.durationMode === 'range') return capabilities.durationRange?.min;
  return undefined;
}

export function normalizeManagedVideoRequest(
  raw: RawManagedVideoRequest,
  canonicalModelKey: string,
  capabilitiesValue: unknown,
): NormalizedVideoRequest {
  const capabilities = resolveVideoCapabilities(capabilitiesValue);
  const explicitDuration = raw.duration;
  if (explicitDuration !== undefined
    && (!Number.isSafeInteger(explicitDuration) || explicitDuration <= 0
      || !videoDurationAllowed(capabilities, explicitDuration))) {
    throw new ManagedVideoRequestError('The selected video model does not support the requested duration');
  }
  const duration = explicitDuration ?? defaultDuration(capabilities);

  const explicitResolution = raw.resolution?.trim().toLowerCase() || undefined;
  if (explicitResolution && capabilities.resolutions.length > 0
    && !capabilities.resolutions.includes(explicitResolution)) {
    throw new ManagedVideoRequestError('The selected video model does not support the requested resolution');
  }
  const resolution = explicitResolution
    ?? capabilities.defaultResolution
    ?? (capabilities.resolutions.length === 1 ? capabilities.resolutions[0] : undefined);
  if (!resolution && capabilities.resolutions.length > 1) {
    throw new ManagedVideoRequestError('A resolution is required for this video model');
  }

  const aspectMode = capabilities.aspectRatioMode
    ?? (capabilities.aspectRatios.length > 0 ? 'list' : undefined);
  const explicitAspectRatio = raw.aspectRatio?.trim().toLowerCase() || undefined;
  let aspectRatio: string | undefined;
  if (aspectMode === 'unspecified') {
    // Old clients sent 16:9 as a schema/UI default. An explicitly unspecified
    // managed capability means no ratio control may reach the adapter.
    aspectRatio = undefined;
  } else {
    aspectRatio = explicitAspectRatio ?? capabilities.defaultAspectRatio
      ?? (capabilities.aspectRatios.length === 1 ? capabilities.aspectRatios[0] : undefined);
    if (aspectRatio && (!isValidAspectRatio(aspectRatio)
      || !videoAspectRatioAllowed(capabilities, aspectRatio))) {
      throw new ManagedVideoRequestError('The selected video model does not support the requested aspect ratio');
    }
    if (!aspectRatio && aspectMode === 'list' && capabilities.aspectRatios.length > 1) {
      throw new ManagedVideoRequestError('An aspect ratio is required for this video model');
    }
  }

  const normalized: NormalizedVideoRequest = {
    canonicalModelKey,
    prompt: raw.prompt,
    inputImages: raw.inputImages,
    inputVideos: raw.inputVideos,
    inputAudios: raw.inputAudios,
    inputMode: raw.inputMode ?? 'REF',
    count: raw.count,
    ...(resolution ? { resolution } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
  };
  if (!videoCapabilitiesSupportRequest(capabilitiesValue, normalized)) {
    throw new ManagedVideoRequestError('The selected video model does not support the requested inputs');
  }
  return normalized;
}
