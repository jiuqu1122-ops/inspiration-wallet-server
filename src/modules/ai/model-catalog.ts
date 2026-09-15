import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

export type AiModality = 'chat' | 'image' | 'video';

const ROUTE_UNAVAILABLE_HEALTH = new Set(['UNAVAILABLE', 'UNHEALTHY', 'DOWN', 'FAILED', 'DISABLED']);

export const routeCanReceiveTraffic = (route: {
  enabled: boolean;
  upstreamAvailable: boolean;
  healthStatus: string;
  channel: { status: string } | null;
}) => (
  route.enabled
  && route.upstreamAvailable
  && !ROUTE_UNAVAILABLE_HEALTH.has(route.healthStatus.trim().toUpperCase())
  && (!route.channel || route.channel.status === 'ACTIVE')
);

export class ModelCatalogError extends Error {
  constructor(
    public readonly code: 'MODEL_NOT_AVAILABLE' | 'MODEL_NOT_FOUND' | 'MODEL_ROUTE_NOT_AVAILABLE' | 'MODEL_IDENTITY_MISMATCH',
    message: string,
    public readonly statusCode = 404,
  ) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}

export const catalogAliasKey = (value: string) => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

const slug = (value: string) => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 120);

export function safeCanonicalModelKey(value: string, modality: AiModality) {
  const candidate = slug(value);
  if (candidate) return candidate;
  return `${modality}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

const IMAGE_ALIAS_MAP: Record<string, string> = {
  nanobananapro: 'nano-banana-pro',
  nanobananaprofast: 'nano-banana-pro-fast',
  xaisnanopro2k: 'nano-banana-pro',
  xaisnanopro4k: 'nano-banana-pro',
  nanobananapro2k0: 'nano-banana-pro',
  nanobananapro4k0: 'nano-banana-pro',
  nanobananapro4k5: 'nano-banana-pro',
  gemini3proimage: 'nano-banana-pro',
  gemini3proimagepreview: 'nano-banana-pro',
  gemini31proimage: 'nano-banana-pro',
  gemini31proimagepreview: 'nano-banana-pro',
  googlegemini3proimage: 'nano-banana-pro',
  googlegemini3proimagepreview: 'nano-banana-pro',
  googlegemini31proimage: 'nano-banana-pro',
  googlegemini31proimagepreview: 'nano-banana-pro',
  modelsgemini3proimage: 'nano-banana-pro',
  modelsgemini3proimagepreview: 'nano-banana-pro',
  modelsgemini31proimage: 'nano-banana-pro',
  modelsgemini31proimagepreview: 'nano-banana-pro',
  xaisnanopro: 'nano-banana-pro',
  nanobanana2: 'nano-banana-2',
  nanobanana2fast: 'nano-banana-2-fast',
  xaisnano22k: 'nano-banana-2',
  xaisnano24k: 'nano-banana-2',
  nanobanana22k0: 'nano-banana-2',
  nanobanana24k0: 'nano-banana-2',
  nanobanana24k5: 'nano-banana-2',
  gemini31flashimage: 'nano-banana-2',
  gemini31flashimagepreview: 'nano-banana-2',
  gemini3flashimage: 'nano-banana-2',
  gemini3flashimagepreview: 'nano-banana-2',
  xaisnano2: 'nano-banana-2',
  gptimage2: 'image2',
  image2: 'image2',
  xaisimg22k: 'image2',
  xaisimg24k: 'image2',
  xaisimg22khighquality: 'image2',
  xaisimg24khighquality: 'image2',
  image22k: 'image2',
  image24k: 'image2',
};

const VIDEO_ALIAS_MAP: Record<string, string> = {
  seedance2: 'seedance-2',
  seedance20: 'seedance-2',
  sourcemix20: 'seedance-2',
  doubaoseedancev2: 'seedance-2',
  seedance2fast: 'seedance-2-fast',
  seedance20fast: 'seedance-2-fast',
  sourcemix20fast: 'seedance-2-fast',
  minimaxh3: 'minimax-h3',
};

const CHAT_ALIAS_MAP: Record<string, string> = {
  gpt56sol: 'gpt-5.6-sol',
  sol56: 'gpt-5.6-sol',
  gpt56: 'gpt-5.6-sol',
  gpt56terra: 'gpt-5.6-terra',
  terra56: 'gpt-5.6-terra',
  gpt56luna: 'gpt-5.6-luna',
  luna56: 'gpt-5.6-luna',
  gpt6astra: 'gpt-6-astra',
  astra6: 'gpt-6-astra',
};

export const EXPLICIT_LEGACY_ALIASES: Record<AiModality, Record<string, string>> = {
  chat: CHAT_ALIAS_MAP,
  image: IMAGE_ALIAS_MAP,
  video: VIDEO_ALIAS_MAP,
};

export function explicitCanonicalModelKey(
  modality: AiModality,
  upstreamModelId: string,
  capabilities: readonly string[] = [],
) {
  const aliasKey = catalogAliasKey(upstreamModelId);
  if (modality === 'image') {
    const normalizedCapabilities = new Set(capabilities.map(value => value.trim().toUpperCase()));
    if (normalizedCapabilities.has('IMAGE_NANO_BANANA_PRO_FAST')
      && IMAGE_ALIAS_MAP[aliasKey] === 'nano-banana-pro') return 'nano-banana-pro-fast';
    if (normalizedCapabilities.has('IMAGE_NANO_BANANA_2_FAST')
      && IMAGE_ALIAS_MAP[aliasKey] === 'nano-banana-2') return 'nano-banana-2-fast';
  }
  return EXPLICIT_LEGACY_ALIASES[modality][aliasKey] ?? null;
}

export function canonicalDisplayName(key: string, fallback?: string) {
  const known: Record<string, string> = {
    'gpt-5.6-sol': 'GPT-5.6 Sol',
    'gpt-5.6-terra': 'GPT-5.6 Terra',
    'gpt-5.6-luna': 'GPT-5.6 Luna',
    'gpt-6-astra': 'GPT-6 Astra',
    'nano-banana-pro': 'Nano Banana Pro',
    'nano-banana-2': 'Nano Banana 2',
    'nano-banana-pro-fast': 'Nano Banana Pro Fast',
    'nano-banana-2-fast': 'Nano Banana 2 Fast',
    image2: 'GPT Image 2',
    'seedance-2': 'Seedance 2.0',
    'seedance-2-fast': 'Seedance 2.0 Fast',
    'minimax-h3': 'MiniMax H3',
  };
  return known[key] ?? fallback?.trim() ?? key;
}

export const GPT_IMAGE_2_ASPECT_RATIO_OPTIONS_BY_RESOLUTION = {
  '1k': [
    '1024x1024',
    '1280x720',
    '720x1280',
    '1152x768',
    '768x1152',
    '1024x768',
    '768x1024',
  ],
  '2k': [
    '2048x2048',
    '2048x1152',
    '1152x2048',
    '2064x1376',
    '1376x2064',
    '2048x1536',
    '1536x2048',
    '2016x864',
    '864x2016',
    '2080x1664',
    '1664x2080',
    '2048x1024',
    '2064x688',
  ],
  '4k': [
    '2880x2880',
    '3840x2160',
    '2160x3840',
    '3520x2352',
    '2352x3520',
    '3312x2480',
    '2480x3312',
    '3840x1648',
    '1648x3840',
    '3216x2576',
    '2576x3216',
    '3840x1920',
    '3840x1280',
    '1280x3840',
  ],
} as const;

export const isGptImage2CatalogIdentity = (...values: Array<string | null | undefined>) => (
  values.some(value => {
    const token = catalogAliasKey(String(value || ''));
    return token === 'image2'
      || token === 'gptimagemedium'
      || token.includes('gptimage2')
      || /^image2(?:\d|h|high|medium)/.test(token);
  })
);

export function withGptImage2DimensionCapabilities(
  capabilities: unknown,
  ...identityValues: Array<string | null | undefined>
) {
  const source = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? capabilities as Record<string, unknown>
    : {};
  if (!isGptImage2CatalogIdentity(...identityValues)) return source;
  const supportedResolutions = Array.isArray(source.supportedResolutions)
    ? source.supportedResolutions
    : ['1k', '2k', '4k'];
  return {
    ...source,
    // Administrators may have created the model before exact dimensions were
    // supported, leaving a legacy ratio map here. Image 2 family dimensions
    // are part of the upstream contract, so replace both accepted aliases.
    // An explicitly configured resolution list is an availability policy,
    // however, and must remain authoritative after an administrator saves it.
    supportedResolutions,
    aspectRatiosByResolution: GPT_IMAGE_2_ASPECT_RATIO_OPTIONS_BY_RESOLUTION,
    supportedAspectRatiosByResolution: GPT_IMAGE_2_ASPECT_RATIO_OPTIONS_BY_RESOLUTION,
  };
}

export function defaultModelCapabilities(key: string, modality: AiModality): Prisma.InputJsonValue {
  if (modality === 'chat') {
    return key === 'gpt-5.6-luna'
      ? { billing: 'request' }
      : { contextTiers: [{ maxInputTokens: 272000 }, { minInputTokens: 272001 }] };
  }
  if (modality === 'image') {
    const gptImage2 = isGptImage2CatalogIdentity(key);
    const supportsOneK = key === 'nano-banana-pro' || gptImage2;
    return {
      supportedResolutions: supportsOneK ? ['1k', '2k', '4k'] : ['2k', '4k'],
      supportedAspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
      ...(gptImage2 ? {
        supportedAspectRatiosByResolution: GPT_IMAGE_2_ASPECT_RATIO_OPTIONS_BY_RESOLUTION,
      } : {}),
      minReferenceImages: 0,
      maxReferenceImages: 9,
      supportsReferenceImage: true,
      supportsTransparentBackground: key === 'image2',
      supportedOutputFormats: ['jpg', 'jpeg', 'png', 'webp'],
    };
  }
  if (key === 'seedance-2' || key === 'seedance-2-fast' || key === 'minimax-h3') {
    return {
      supportedResolutions: key === 'minimax-h3' ? ['768p', '1080p', '2k'] : ['480p', '720p', '1080p'],
      supportedDurations: [4, 5, 10, 15],
      supportedAspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
      maxReferenceImages: 9,
      maxReferenceVideos: 3,
      maxReferenceAudios: 3,
      supportsFirstLastFrame: true,
      supportsAudioReference: true,
      supportsVideoReference: true,
      supportedInputModes: ['REF', 'FLF'],
      maxOutputs: 4,
    };
  }
  return {};
}

export function normalizePublicModelCapabilities(value: unknown) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const stringArray = (...keys: string[]) => {
    for (const key of keys) {
      if (Array.isArray(source[key])) {
        return source[key]
          .filter((item): item is string => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean);
      }
    }
    return undefined;
  };
  const numberArray = (...keys: string[]) => {
    for (const key of keys) {
      if (Array.isArray(source[key])) {
        return source[key]
          .map(Number)
          .filter(item => Number.isFinite(item));
      }
    }
    return undefined;
  };
  const numberValue = (...keys: string[]) => {
    for (const key of keys) {
      const candidate = source[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    }
    return undefined;
  };
  const booleanValue = (...keys: string[]) => {
    for (const key of keys) {
      if (typeof source[key] === 'boolean') return source[key];
    }
    return undefined;
  };
  const stringArrayMap = (...keys: string[]) => {
    for (const key of keys) {
      const candidate = source[key];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const normalized = Object.fromEntries(Object.entries(candidate)
        .flatMap(([resolution, options]) => {
          if (!Array.isArray(options)) return [];
          const values = options
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean);
          return values.length > 0 ? [[resolution.trim().toLowerCase(), values] as const] : [];
        }));
      if (Object.keys(normalized).length > 0) return normalized;
    }
    return undefined;
  };
  return Object.fromEntries(Object.entries({
    resolutions: stringArray('resolutions', 'supportedResolutions'),
    aspectRatios: stringArray('aspectRatios', 'supportedAspectRatios'),
    aspectRatiosByResolution: stringArrayMap(
      'aspectRatiosByResolution',
      'supportedAspectRatiosByResolution',
    ),
    durations: numberArray('durations', 'supportedDurations'),
    maxReferenceImages: numberValue('maxReferenceImages'),
    maxReferenceVideos: numberValue('maxReferenceVideos'),
    maxReferenceAudios: numberValue('maxReferenceAudios'),
    minReferenceImages: numberValue('minReferenceImages'),
    supportsReferenceImages: booleanValue('supportsReferenceImages', 'supportsReferenceImage'),
    supportsReferenceVideo: booleanValue('supportsReferenceVideo', 'supportsVideoReference'),
    supportsAudioReference: booleanValue('supportsAudioReference'),
    supportsFirstLastFrame: booleanValue('supportsFirstLastFrame'),
    supportedInputModes: stringArray('supportedInputModes'),
    supportedOutputFormats: stringArray('supportedOutputFormats'),
    supportsTransparentBackground: booleanValue('supportsTransparentBackground'),
    supportsVision: booleanValue('supportsVision'),
    maxOutputs: numberValue('maxOutputs'),
  }).filter((entry): entry is [string, Exclude<typeof entry[1], undefined>] => entry[1] !== undefined));
}

export function catalogDelegateAvailable(prisma: PrismaClient) {
  return Boolean((prisma as PrismaClient & { aiModel?: unknown }).aiModel);
}

export async function getPublicAiCatalog(prisma: PrismaClient) {
  const models = await prisma.aiModel.findMany({
    where: { enabled: true, visible: true, status: 'PUBLISHED' },
    include: {
      pricing: { include: { currentVersion: true } },
      aliases: { where: { confirmed: true }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: [{ modality: 'asc' }, { sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
  });
  // A per-model price version is not a catalog revision: publishing version 2
  // for one model must still invalidate a catalog that already contains
  // another model at version 10. Use the latest public model/price timestamp as
  // the monotonic catalog revision while retaining each model's priceVersion.
  const version = models.reduce((highest, model) => Math.max(
    highest,
    model.updatedAt instanceof Date ? model.updatedAt.getTime() : 0,
    model.pricing?.currentVersion?.publishedAt instanceof Date
      ? model.pricing.currentVersion.publishedAt.getTime()
      : 0,
  ), 0);
  return {
    version,
    models: models.map(model => {
      const aliases = (model.aliases ?? []).map(alias => alias.alias);
      return {
        id: model.canonicalModelKey,
        displayName: model.displayName,
        modality: model.modality,
        billingType: model.billingType,
        aliases,
        capabilities: normalizePublicModelCapabilities(model.modality === 'image'
          ? withGptImage2DimensionCapabilities(
            model.capabilities,
            model.canonicalModelKey,
            model.displayName,
            ...aliases,
          )
          : model.capabilities),
        priceVersion: model.pricing?.currentVersion?.version ?? null,
        pricing: model.pricing?.currentVersion?.pricing ?? null,
      };
    }),
  };
}

export type ResolvedCatalogModel = Awaited<ReturnType<typeof resolveCatalogModel>>;

export async function resolveCatalogModel(
  prisma: PrismaClient,
  requestedModel: string,
  modality: AiModality,
  options: { requireEnabled?: boolean; providerChannelId?: string } = {},
) {
  if (!catalogDelegateAvailable(prisma)) return null;
  const requested = requestedModel.trim();
  const direct = requested
    ? await prisma.aiModel.findUnique({
      where: { canonicalModelKey: requested.toLowerCase() },
      include: { routes: { include: { channel: true }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] } },
    })
    : null;
  const aliased = direct ?? (requested
    ? (await prisma.aiModelAlias.findUnique({
      where: { modality_aliasKey: { modality, aliasKey: catalogAliasKey(requested) } },
      include: {
        canonicalModel: {
          include: { routes: { include: { channel: true }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] } },
        },
      },
    }))?.canonicalModel ?? null
    : null);
  if (!aliased || aliased.modality !== modality) {
    throw new ModelCatalogError('MODEL_NOT_FOUND', `Unknown ${modality} model`, 404);
  }
  if (options.requireEnabled !== false && (
    !aliased.enabled
    || ('status' in aliased && aliased.status !== undefined && aliased.status !== 'PUBLISHED')
  )) {
    throw new ModelCatalogError('MODEL_NOT_AVAILABLE', 'The selected model is not available', 409);
  }
  const enabledRoutes = aliased.routes.filter(routeCanReceiveTraffic);
  const managedRouting = aliased.routingMode === 'MANAGED';
  if (managedRouting && enabledRoutes.every(route => route.channelId === null)) {
    throw new ModelCatalogError(
      'MODEL_ROUTE_NOT_AVAILABLE',
      'No enabled upstream route is available for the selected model',
      503,
    );
  }
  if (options.providerChannelId && !managedRouting) {
    const enabledForChannel = enabledRoutes.some(route => route.channelId === options.providerChannelId);
    if (!enabledForChannel) {
      throw new ModelCatalogError(
        'MODEL_ROUTE_NOT_AVAILABLE',
        'The selected model route is disabled or unavailable',
        409,
      );
    }
  }
  const selectedRoute = options.providerChannelId && !managedRouting
    ? enabledRoutes.find(route => route.channelId === options.providerChannelId) ?? null
    : aliased.defaultRouteId
      ? enabledRoutes.find(route => route.id === aliased.defaultRouteId) ?? enabledRoutes[0] ?? null
      : enabledRoutes[0] ?? null;
  return {
    model: aliased,
    route: selectedRoute,
    enabledRoutes,
    requestIdentity: {
      requestedModel: requested,
      requestedCanonicalModel: aliased.canonicalModelKey,
      matchedBy: direct ? 'canonical' as const : 'alias' as const,
    },
  };
}

export function assertCanonicalModelIdentity(
  requestedCanonicalModel: string | null | undefined,
  resolvedCanonicalModel: string,
) {
  const requested = requestedCanonicalModel?.trim().toLowerCase();
  if (!requested || requested === resolvedCanonicalModel.trim().toLowerCase()) return;
  throw new ModelCatalogError(
    'MODEL_IDENTITY_MISMATCH',
    `Requested canonical model ${requestedCanonicalModel} resolved as ${resolvedCanonicalModel}`,
    409,
  );
}

export async function resolveAutomaticChatModel(prisma: PrismaClient) {
  if (!catalogDelegateAvailable(prisma)) return null;
  const models = await prisma.aiModel.findMany({
    where: { modality: 'chat', enabled: true, visible: true, status: 'PUBLISHED' },
    include: { routes: { include: { channel: true }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] } },
    orderBy: [{ sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
  });
  for (const model of models) {
    const enabledRoutes = model.routes.filter(routeCanReceiveTraffic);
    if (model.routingMode === 'MANAGED'
      && enabledRoutes.every(route => route.channelId === null)) continue;
    const route = model.defaultRouteId
      ? enabledRoutes.find(candidate => candidate.id === model.defaultRouteId) ?? enabledRoutes[0] ?? null
      : enabledRoutes[0] ?? null;
    return { model, route, enabledRoutes };
  }
  throw new ModelCatalogError('MODEL_NOT_AVAILABLE', 'No Chat model with an enabled route is currently available', 503);
}

export function legacyUpstreamModelForCanonical(
  canonicalModelKey: string,
  modality: AiModality,
) {
  if (modality === 'video') {
    if (canonicalModelKey === 'seedance-2') return 'seedance2';
    if (canonicalModelKey === 'seedance-2-fast') return 'seedance2fast';
    if (canonicalModelKey === 'minimax-h3') return 'MiniMax-H3';
  }
  if (modality === 'image') {
    if (canonicalModelKey === 'nano-banana-pro') return 'gemini-3-pro-image';
    if (canonicalModelKey === 'nano-banana-2') return 'gemini-3.1-flash-image';
    if (canonicalModelKey === 'image2') return 'gpt-image-2';
    if (canonicalModelKey === 'nano-banana-pro-fast') return 'gemini-3-pro-image';
    if (canonicalModelKey === 'nano-banana-2-fast') return 'gemini-3.1-flash-image';
  }
  return canonicalModelKey;
}
