import { AdminOperationType, Prisma, type PrismaClient } from '@prisma/client';
import { AiModelAdminError, recordAdminOperation, type AdminMutationContext } from './model-admin.js';
import { routeCanReceiveTraffic } from './model-catalog.js';

export const AI_USAGE_MODEL_KEYS = ['IMAGE_ANALYSIS', 'CANVAS_TEXT'] as const;
export type AiUsageModelKey = typeof AI_USAGE_MODEL_KEYS[number];

export class UsageModelBindingError extends Error {
  constructor(
    public readonly code: 'USAGE_MODEL_NOT_AVAILABLE',
    message: string,
    public readonly statusCode = 503,
  ) {
    super(message);
    this.name = 'UsageModelBindingError';
  }
}

const objectValue = (value: unknown) => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const supportsVisionCapability = (value: unknown) => objectValue(value).supportsVision === true;

type UsageRouteInput = {
  enabled: boolean;
  upstreamAvailable: boolean;
  healthStatus: string;
  capabilitiesOverride: unknown;
  channel: { status: string; capabilities: string[] } | null;
};

export function routeSupportsUsage(key: AiUsageModelKey, modelCapabilities: unknown, route: UsageRouteInput) {
  if (!routeCanReceiveTraffic(route) || !route.channel) return false;
  if (key !== 'IMAGE_ANALYSIS') return true;
  return supportsVisionCapability(modelCapabilities)
    || supportsVisionCapability(route.capabilitiesOverride)
    || route.channel?.capabilities.includes('VISION') === true;
}

const includeUsageRoutes = Prisma.validator<Prisma.AiModelInclude>()({
  routes: {
    include: { channel: true },
    orderBy: [{ priority: 'asc' }, { id: 'asc' }],
  },
});

type UsageModel = Prisma.AiModelGetPayload<{ include: typeof includeUsageRoutes }>;

function operationalUsageRoutes<T extends UsageRouteInput>(
  key: AiUsageModelKey,
  model: { capabilities: unknown; routes: T[] },
): T[] {
  return model.routes.filter(route => routeSupportsUsage(key, model.capabilities, route));
}

function selectedUsageRoute<T extends { id: string }>(
  defaultRouteId: string | null,
  routes: T[],
) {
  return defaultRouteId
    ? routes.find(route => route.id === defaultRouteId) ?? routes[0] ?? null
    : routes[0] ?? null;
}

export async function resolveUsageModelBinding(prisma: PrismaClient, key: AiUsageModelKey) {
  const binding = await prisma.aiUsageModelBinding.findUnique({
    where: { key },
    include: { canonicalModel: { include: includeUsageRoutes } },
  });
  const model = binding?.canonicalModel;
  if (!model
    || model.modality !== 'chat'
    || !model.enabled
    || model.status !== 'PUBLISHED') {
    throw new UsageModelBindingError(
      'USAGE_MODEL_NOT_AVAILABLE',
      `The ${key} usage model binding is missing, disabled, or unpublished`,
    );
  }
  const enabledRoutes = operationalUsageRoutes(key, model);
  if (enabledRoutes.length === 0) {
    throw new UsageModelBindingError(
      'USAGE_MODEL_NOT_AVAILABLE',
      `The ${key} usage model has no operational${key === 'IMAGE_ANALYSIS' ? ' vision-capable' : ''} route`,
    );
  }
  const route = selectedUsageRoute(model.defaultRouteId, enabledRoutes);
  return { binding, model, route, enabledRoutes };
}

const usageBindingView = (key: AiUsageModelKey, binding: {
  key: string;
  canonicalModelId: string;
  updatedAt: Date;
  canonicalModel: UsageModel;
} | null) => {
  const operationalRoutes = binding
    ? operationalUsageRoutes(key, binding.canonicalModel)
    : [];
  return {
    key,
    canonicalModelId: binding?.canonicalModelId ?? null,
    canonicalModelKey: binding?.canonicalModel.canonicalModelKey ?? null,
    displayName: binding?.canonicalModel.displayName ?? null,
    updatedAt: binding?.updatedAt ?? null,
    operational: Boolean(
      binding
      && binding.canonicalModel.modality === 'chat'
      && binding.canonicalModel.enabled
      && binding.canonicalModel.status === 'PUBLISHED'
      && operationalRoutes.length > 0
    ),
    route: binding
      ? selectedUsageRoute(binding.canonicalModel.defaultRouteId, operationalRoutes)
      : null,
  };
};

export async function listAdminUsageModelBindings(prisma: PrismaClient) {
  const [bindings, models] = await Promise.all([
    prisma.aiUsageModelBinding.findMany({
      where: { key: { in: [...AI_USAGE_MODEL_KEYS] } },
      include: { canonicalModel: { include: includeUsageRoutes } },
    }),
    prisma.aiModel.findMany({
      where: { modality: 'chat', enabled: true, status: 'PUBLISHED' },
      include: includeUsageRoutes,
      orderBy: [{ sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
    }),
  ]);
  const byKey = new Map(bindings.map(binding => [binding.key, binding]));
  return {
    items: AI_USAGE_MODEL_KEYS.map(key => usageBindingView(key, byKey.get(key) ?? null)),
    candidates: {
      CANVAS_TEXT: models
        .filter(model => operationalUsageRoutes('CANVAS_TEXT', model).length > 0)
        .map(model => ({
          id: model.id,
          canonicalModelKey: model.canonicalModelKey,
          displayName: model.displayName,
        })),
      IMAGE_ANALYSIS: models
        .filter(model => operationalUsageRoutes('IMAGE_ANALYSIS', model).length > 0)
        .map(model => ({
          id: model.id,
          canonicalModelKey: model.canonicalModelKey,
          displayName: model.displayName,
        })),
    },
  };
}

export async function updateAdminUsageModelBinding(
  prisma: PrismaClient,
  key: AiUsageModelKey,
  canonicalModelId: string,
  context: AdminMutationContext,
) {
  return prisma.$transaction(async (transaction) => {
    const model = await transaction.aiModel.findUnique({
      where: { id: canonicalModelId },
      include: includeUsageRoutes,
    });
    if (!model) throw new AiModelAdminError('NOT_FOUND', 'Canonical model was not found', 404);
    if (model.modality !== 'chat' || !model.enabled || model.status !== 'PUBLISHED') {
      throw new AiModelAdminError(
        'INVALID_REQUEST',
        'Usage bindings require an enabled, published canonical Chat model',
        400,
      );
    }
    const eligibleRoutes = operationalUsageRoutes(key, model);
    if (eligibleRoutes.length === 0) {
      throw new AiModelAdminError(
        'INVALID_REQUEST',
        key === 'IMAGE_ANALYSIS'
          ? 'Image analysis requires an operational vision-capable route'
          : 'The canonical Chat model has no operational route',
        400,
      );
    }
    const before = await transaction.aiUsageModelBinding.findUnique({ where: { key } });
    const binding = await transaction.aiUsageModelBinding.upsert({
      where: { key },
      create: { key, canonicalModelId },
      update: { canonicalModelId },
    });
    await recordAdminOperation(
      transaction,
      AdminOperationType.USAGE_MODEL_BINDING_UPDATED,
      context,
      {
        schemaVersion: 1,
        usageKey: key,
        beforeCanonicalModelId: before?.canonicalModelId ?? null,
        afterCanonicalModelId: canonicalModelId,
      },
    );
    return usageBindingView(key, {
      ...binding,
      canonicalModel: model,
    });
  }, { isolationLevel: 'Serializable' });
}

export async function ensureDefaultUsageModelBindings(transaction: Prisma.TransactionClient) {
  const delegates = transaction as Prisma.TransactionClient & {
    aiUsageModelBinding?: { findUnique?: unknown };
    aiModel?: { findMany?: unknown };
  };
  if (typeof delegates.aiUsageModelBinding?.findUnique !== 'function'
    || typeof delegates.aiModel?.findMany !== 'function') return;
  const models = await transaction.aiModel.findMany({
    where: { modality: 'chat' },
    include: includeUsageRoutes,
    orderBy: [{ sortOrder: 'asc' }, { canonicalModelKey: 'asc' }],
  });
  const preferred = [...models].sort((left, right) => {
    const rank = (key: string) => key === 'gpt-5.6-sol' ? 0 : key === 'gpt-6-astra' ? 1 : 2;
    return rank(left.canonicalModelKey) - rank(right.canonicalModelKey);
  });
  for (const key of AI_USAGE_MODEL_KEYS) {
    const existing = await transaction.aiUsageModelBinding.findUnique({ where: { key } });
    if (existing) continue;
    const model = preferred.find(candidate => (
      candidate.enabled
      && candidate.status === 'PUBLISHED'
      && operationalUsageRoutes(key, candidate).length > 0
    ));
    if (model) {
      await transaction.aiUsageModelBinding.create({ data: { key, canonicalModelId: model.id } });
    }
  }
}
