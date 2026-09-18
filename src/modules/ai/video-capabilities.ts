import { normalizePublicModelCapabilities } from './model-catalog.js';

export type VideoDurationMode = 'list' | 'range' | 'fixed';
export type VideoAspectRatioMode = 'list' | 'any' | 'unspecified';

export type VideoCapabilities = {
  resolutions: string[];
  defaultResolution?: string;
  durations: number[];
  durationMode?: VideoDurationMode;
  durationRange?: { min: number; max: number; step: number };
  defaultDurationSeconds?: number;
  aspectRatios: string[];
  aspectRatioMode?: VideoAspectRatioMode;
  defaultAspectRatio?: string;
  minReferenceImages: number;
  maxReferenceImages?: number;
  minReferenceVideos: number;
  maxReferenceVideos?: number;
  minReferenceAudios: number;
  maxReferenceAudios?: number;
  supportsReferenceImages?: boolean;
  supportsReferenceVideo?: boolean;
  supportsReferenceAudio?: boolean;
  supportsFirstFrame?: boolean;
  supportsLastFrame?: boolean;
  supportsFirstLastFrame?: boolean;
  supportedInputModes: string[];
  maxOutputs?: number;
};

export type VideoRequestShape = {
  resolution?: string | undefined;
  duration?: number | undefined;
  aspectRatio?: string | undefined;
  inputImages: readonly unknown[];
  inputVideos: readonly unknown[];
  inputAudios: readonly unknown[];
  inputMode?: 'REF' | 'FLF' | undefined;
  count: number;
  prompt?: string;
};

const finiteInteger = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
};

const optionalFiniteInteger = (value: unknown) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};

const normalizeMode = <T extends string>(value: unknown, allowed: readonly T[]) => (
  typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined
);

export function resolveVideoCapabilities(value: unknown): VideoCapabilities {
  const publicCapabilities = normalizePublicModelCapabilities(value) as Record<string, unknown>;
  const rangeValue = publicCapabilities.durationRange;
  const range = rangeValue && typeof rangeValue === 'object' && !Array.isArray(rangeValue)
    ? rangeValue as Record<string, unknown>
    : undefined;
  const min = range ? optionalFiniteInteger(range.min) : undefined;
  const max = range ? optionalFiniteInteger(range.max) : undefined;
  const step = range ? optionalFiniteInteger(range.step) ?? 1 : undefined;
  const maxReferenceImages = optionalFiniteInteger(publicCapabilities.maxReferenceImages);
  const maxReferenceVideos = optionalFiniteInteger(publicCapabilities.maxReferenceVideos);
  const maxReferenceAudios = optionalFiniteInteger(publicCapabilities.maxReferenceAudios);
  const maxOutputs = optionalFiniteInteger(publicCapabilities.maxOutputs);
  return {
    resolutions: Array.isArray(publicCapabilities.resolutions)
      ? publicCapabilities.resolutions.map(String).map(item => item.trim().toLowerCase()).filter(Boolean)
      : [],
    ...(typeof publicCapabilities.defaultResolution === 'string'
      ? { defaultResolution: publicCapabilities.defaultResolution.trim().toLowerCase() }
      : {}),
    durations: Array.isArray(publicCapabilities.durations)
      ? publicCapabilities.durations.map(Number).filter(item => Number.isSafeInteger(item) && item > 0)
      : [],
    ...(normalizeMode(publicCapabilities.durationMode, ['list', 'range', 'fixed'] as const)
      ? { durationMode: normalizeMode(publicCapabilities.durationMode, ['list', 'range', 'fixed'] as const)! }
      : {}),
    ...(min !== undefined && max !== undefined && min > 0 && max >= min
      ? { durationRange: { min, max, step: Math.max(1, step ?? 1) } }
      : {}),
    ...(optionalFiniteInteger(publicCapabilities.defaultDurationSeconds)
      ? { defaultDurationSeconds: optionalFiniteInteger(publicCapabilities.defaultDurationSeconds)! }
      : {}),
    aspectRatios: Array.isArray(publicCapabilities.aspectRatios)
      ? publicCapabilities.aspectRatios.map(String).map(item => item.trim().toLowerCase()).filter(Boolean)
      : [],
    ...(normalizeMode(publicCapabilities.aspectRatioMode, ['list', 'any', 'unspecified'] as const)
      ? { aspectRatioMode: normalizeMode(publicCapabilities.aspectRatioMode, ['list', 'any', 'unspecified'] as const)! }
      : {}),
    ...(typeof publicCapabilities.defaultAspectRatio === 'string'
      ? { defaultAspectRatio: publicCapabilities.defaultAspectRatio.trim().toLowerCase() }
      : {}),
    minReferenceImages: finiteInteger(publicCapabilities.minReferenceImages),
    ...(maxReferenceImages !== undefined
      ? { maxReferenceImages }
      : {}),
    minReferenceVideos: finiteInteger(publicCapabilities.minReferenceVideos),
    ...(maxReferenceVideos !== undefined
      ? { maxReferenceVideos }
      : {}),
    minReferenceAudios: finiteInteger(publicCapabilities.minReferenceAudios),
    ...(maxReferenceAudios !== undefined
      ? { maxReferenceAudios }
      : {}),
    ...(typeof publicCapabilities.supportsReferenceImages === 'boolean'
      ? { supportsReferenceImages: publicCapabilities.supportsReferenceImages }
      : {}),
    ...(typeof publicCapabilities.supportsReferenceVideo === 'boolean'
      ? { supportsReferenceVideo: publicCapabilities.supportsReferenceVideo }
      : {}),
    ...(typeof publicCapabilities.supportsReferenceAudio === 'boolean'
      ? { supportsReferenceAudio: publicCapabilities.supportsReferenceAudio }
      : {}),
    ...(typeof publicCapabilities.supportsFirstFrame === 'boolean'
      ? { supportsFirstFrame: publicCapabilities.supportsFirstFrame }
      : {}),
    ...(typeof publicCapabilities.supportsLastFrame === 'boolean'
      ? { supportsLastFrame: publicCapabilities.supportsLastFrame }
      : {}),
    ...(typeof publicCapabilities.supportsFirstLastFrame === 'boolean'
      ? { supportsFirstLastFrame: publicCapabilities.supportsFirstLastFrame }
      : {}),
    supportedInputModes: Array.isArray(publicCapabilities.supportedInputModes)
      ? publicCapabilities.supportedInputModes.map(String).map(item => item.trim().toUpperCase()).filter(Boolean)
      : [],
    ...(maxOutputs !== undefined
      ? { maxOutputs }
      : {}),
  };
}

export const isValidAspectRatio = (value: string) => {
  const match = value.trim().match(/^([1-9]\d{0,4}):([1-9]\d{0,4})$/);
  return Boolean(match && Number(match[1]) > 0 && Number(match[2]) > 0);
};

export function videoDurationAllowed(capabilities: VideoCapabilities, duration: number) {
  const mode = capabilities.durationMode
    ?? (capabilities.durations.length > 0 ? 'list' : undefined);
  if (mode === 'range') {
    const range = capabilities.durationRange;
    return Boolean(range
      && duration >= range.min
      && duration <= range.max
      && (duration - range.min) % range.step === 0);
  }
  if (mode === 'list' || mode === 'fixed') return capabilities.durations.includes(duration);
  return true;
}

export function videoAspectRatioAllowed(capabilities: VideoCapabilities, aspectRatio?: string) {
  const mode = capabilities.aspectRatioMode
    ?? (capabilities.aspectRatios.length > 0 ? 'list' : undefined);
  if (mode === 'unspecified') return !aspectRatio;
  if (!aspectRatio) return true;
  const normalized = aspectRatio.trim().toLowerCase();
  if (mode === 'any') return isValidAspectRatio(normalized);
  if (mode === 'list') return capabilities.aspectRatios.includes(normalized);
  return true;
}

const inBounds = (count: number, minimum: number, maximum?: number) => (
  count >= minimum && (maximum === undefined || count <= maximum)
);

export function videoCapabilitiesSupportRequest(
  capabilitiesValue: unknown,
  input: VideoRequestShape,
) {
  const capabilities = resolveVideoCapabilities(capabilitiesValue);
  const resolution = input.resolution?.trim().toLowerCase();
  if (resolution && capabilities.resolutions.length > 0
    && !capabilities.resolutions.includes(resolution)) return false;
  if (input.duration !== undefined && !videoDurationAllowed(capabilities, input.duration)) return false;
  if (!videoAspectRatioAllowed(capabilities, input.aspectRatio)) return false;
  if (capabilities.maxOutputs !== undefined && input.count > capabilities.maxOutputs) return false;
  if (capabilities.supportedInputModes.length > 0
    && !capabilities.supportedInputModes.includes(input.inputMode ?? 'REF')) return false;

  if (input.inputMode === 'FLF') {
    if (input.inputVideos.length > 0 || input.inputAudios.length > 0) return false;
    if (input.inputImages.length === 1
      && capabilities.supportsFirstFrame === false
      && capabilities.supportsFirstLastFrame !== true) return false;
    if (input.inputImages.length >= 2
      && capabilities.supportsFirstLastFrame !== true
      && !(capabilities.supportsFirstFrame === true && capabilities.supportsLastFrame === true)) return false;
  } else {
    if (input.inputImages.length > 0 && capabilities.supportsReferenceImages === false) return false;
    if (!inBounds(input.inputImages.length, capabilities.minReferenceImages, capabilities.maxReferenceImages)) return false;
  }
  if (input.inputVideos.length > 0 && capabilities.supportsReferenceVideo === false) return false;
  if (!inBounds(input.inputVideos.length, capabilities.minReferenceVideos, capabilities.maxReferenceVideos)) return false;
  if (input.inputAudios.length > 0 && capabilities.supportsReferenceAudio === false) return false;
  return inBounds(input.inputAudios.length, capabilities.minReferenceAudios, capabilities.maxReferenceAudios);
}

export function assertVideoCapabilitiesSubset(canonicalValue: unknown, routeValue: unknown) {
  const canonical = resolveVideoCapabilities(canonicalValue);
  const route = resolveVideoCapabilities(routeValue);
  const subset = <T>(parent: readonly T[], child: readonly T[]) => (
    parent.length === 0 || child.every(value => parent.includes(value))
  );
  if (!subset(canonical.resolutions, route.resolutions)) {
    throw new Error('Route resolutions must be a subset of canonical capabilities');
  }
  const routeDurations = route.durationMode === 'range' && route.durationRange
    ? Array.from(
      { length: Math.floor((route.durationRange.max - route.durationRange.min) / route.durationRange.step) + 1 },
      (_, index) => route.durationRange!.min + index * route.durationRange!.step,
    )
    : route.durations;
  if (routeDurations.some(duration => !videoDurationAllowed(canonical, duration))) {
    throw new Error('Route durations must be a subset of canonical capabilities');
  }
  const canonicalAspectMode = canonical.aspectRatioMode ?? (canonical.aspectRatios.length ? 'list' : undefined);
  const routeAspectMode = route.aspectRatioMode ?? (route.aspectRatios.length ? 'list' : undefined);
  if (canonicalAspectMode === 'list'
    && (routeAspectMode === 'any' || !subset(canonical.aspectRatios, route.aspectRatios))) {
    throw new Error('Route aspect ratios must be a subset of canonical capabilities');
  }
  if (canonicalAspectMode === 'unspecified' && routeAspectMode !== 'unspecified') {
    throw new Error('An unspecified canonical aspect ratio cannot be widened by a route');
  }
  const referenceBounds = [
    ['images', canonical.minReferenceImages, canonical.maxReferenceImages, route.minReferenceImages, route.maxReferenceImages],
    ['videos', canonical.minReferenceVideos, canonical.maxReferenceVideos, route.minReferenceVideos, route.maxReferenceVideos],
    ['audios', canonical.minReferenceAudios, canonical.maxReferenceAudios, route.minReferenceAudios, route.maxReferenceAudios],
  ] as const;
  for (const [label, canonicalMin, canonicalMax, routeMin, routeMax] of referenceBounds) {
    if (routeMin < canonicalMin || (canonicalMax !== undefined && (routeMax === undefined || routeMax > canonicalMax))) {
      throw new Error(`Route reference ${label} limits must be within canonical capabilities`);
    }
  }
  const supportPairs = [
    [canonical.supportsReferenceImages, route.supportsReferenceImages, 'reference images'],
    [canonical.supportsReferenceVideo, route.supportsReferenceVideo, 'reference videos'],
    [canonical.supportsReferenceAudio, route.supportsReferenceAudio, 'reference audios'],
    [canonical.supportsFirstFrame, route.supportsFirstFrame, 'first frame'],
    [canonical.supportsLastFrame, route.supportsLastFrame, 'last frame'],
    [canonical.supportsFirstLastFrame, route.supportsFirstLastFrame, 'first/last frame'],
  ] as const;
  for (const [canonicalSupport, routeSupport, label] of supportPairs) {
    if (canonicalSupport === false && routeSupport === true) {
      throw new Error(`Route cannot enable ${label} outside canonical capabilities`);
    }
  }
  if (!subset(canonical.supportedInputModes, route.supportedInputModes)) {
    throw new Error('Route input modes must be a subset of canonical capabilities');
  }
  if (canonical.maxOutputs !== undefined
    && (route.maxOutputs === undefined || route.maxOutputs > canonical.maxOutputs)) {
    throw new Error('Route maxOutputs must not exceed canonical capabilities');
  }
}
