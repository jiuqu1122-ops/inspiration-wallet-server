import { Prisma, type AiRequest, type PrismaClient } from '@prisma/client';
import { creditDecimal, serializeCredit } from '../wallets/credit-amount.js';
import { calculateSnapshotCharge, toInputJson, type PricingSnapshot } from './pricing-center.js';
import { CloudAiError } from './service.js';
import { isImageOperation, isImageOperationSpeed } from './image-operation-pricing.js';

type OperationRequestIdentity = { userId: string; clientRequestId: string; model: string };
const journalRecord = (value: unknown): Record<string, unknown> | undefined => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function requireOperationSnapshot(snapshot: PricingSnapshot) {
  if (snapshot.modality !== 'image' || !isImageOperation(snapshot.request.operation)
    || !isImageOperationSpeed(snapshot.request.speed) || typeof snapshot.request.operationUnitCredits !== 'string') {
    throw new CloudAiError('image_operation_price_missing', '原操作价格快照不完整，需管理员核对', 409);
  }
}

/** An operation receipt is never recycled, including after an explicit failure. */
export async function reserveOperationCredits(
  prisma: PrismaClient,
  input: OperationRequestIdentity,
  snapshot: PricingSnapshot,
  initialJournal: Prisma.InputJsonObject,
): Promise<{ created: boolean; request: AiRequest }> {
  requireOperationSnapshot(snapshot);
  if (initialJournal.imageOperationVersion !== 1 || initialJournal.operation !== snapshot.request.operation
    || initialJournal.speed !== snapshot.request.speed) {
    throw new CloudAiError('image_operation_price_mismatch', '操作与原始价格不一致', 409);
  }
  const identity = { userId: input.userId, clientRequestId: input.clientRequestId };
  try {
    return await prisma.$transaction(async transaction => {
      const existing = await transaction.aiRequest.findUnique({ where: { userId_clientRequestId: identity } });
      if (existing) return { created: false, request: existing };
      const estimatedCredits = creditDecimal(calculateSnapshotCharge(snapshot).totalCredits);
      const claimed = await transaction.wallet.updateMany({
        where: { userId: input.userId, availableCredits: { gte: estimatedCredits } },
        data: { availableCredits: { decrement: estimatedCredits }, reservedCredits: { increment: estimatedCredits } },
      });
      if (claimed.count !== 1) throw new CloudAiError('insufficient_credits', '授权钱包余额不足', 402);
      const request = await transaction.aiRequest.create({ data: {
        ...identity, logicalModel: snapshot.canonicalModelKey, capability: 'IMAGE', status: 'RESERVED',
        canonicalModelId: snapshot.canonicalModelId, routeId: snapshot.routeId,
        priceVersionId: snapshot.priceVersionId, pricingSnapshot: toInputJson(snapshot),
        estimatedCredits, result: initialJournal,
      } });
      const wallet = await transaction.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
      await transaction.walletLedger.create({ data: {
        userId: input.userId, requestId: request.id, type: 'RESERVE', amount: estimatedCredits.negated(),
        balanceAfter: wallet.availableCredits, description: '图片操作预扣',
      } });
      return { created: true, request };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const request = await prisma.aiRequest.findUnique({ where: { userId_clientRequestId: identity } });
      if (request) return { created: false, request };
    }
    throw error;
  }
}

/** A successful operation is one unit, including text and modal-only results. */
export async function settleOperationCredits(
  prisma: PrismaClient, userId: string, requestId: string, finalJournal: Prisma.InputJsonObject,
) {
  await prisma.$transaction(async transaction => {
    const request = await transaction.aiRequest.findUnique({ where: { id: requestId } });
    if (!request || request.userId !== userId || request.capability !== 'IMAGE'
      || !['RESERVED', 'PROCESSING'].includes(request.status)) return;
    const snapshot = request.pricingSnapshot as PricingSnapshot | null;
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.modality !== 'image'
      || typeof snapshot.request.operation !== 'string' || typeof snapshot.request.operationUnitCredits !== 'string') {
      throw new CloudAiError('image_operation_price_missing', '原操作价格快照不完整，需管理员核对', 409);
    }
    requireOperationSnapshot(snapshot);
    const currentJournal = journalRecord(request.result);
    if (!currentJournal || !currentJournal.taskId || currentJournal.taskId !== finalJournal.taskId
      || currentJournal.imageOperationVersion !== 1 || finalJournal.imageOperationVersion !== 1
      || ['fingerprint', 'providerId', 'routeId', 'submittedModel', 'receiptKey', 'operation', 'speed']
        .some(key => currentJournal[key] !== finalJournal[key])
      || finalJournal.operation !== snapshot.request.operation || finalJournal.speed !== snapshot.request.speed) {
      throw new CloudAiError('image_operation_identity_mismatch', '原操作回执已变化，需重新查询原任务', 409);
    }
    const breakdown = calculateSnapshotCharge(snapshot, { generatedCount: 1 });
    const chargedCredits = creditDecimal(breakdown.totalCredits);
    const estimatedCredits = creditDecimal(request.estimatedCredits);
    if (chargedCredits.gt(estimatedCredits)) {
      throw new CloudAiError('image_operation_price_mismatch', '原操作预扣与价格快照不一致，需管理员核对', 409);
    }
    const refund = estimatedCredits.minus(chargedCredits);
    const claimed = await transaction.aiRequest.updateMany({
      where: { id: requestId, userId, status: { in: ['RESERVED', 'PROCESSING'] } },
      data: { status: 'SUCCEEDED', chargedCredits, chargeBreakdown: toInputJson(breakdown),
        result: { ...finalJournal, chargedCredits: serializeCredit(chargedCredits) }, completedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    await transaction.aiBillingSettlement.create({ data: {
      requestId, canonicalModelId: snapshot.canonicalModelId, routeId: snapshot.routeId,
      priceVersionId: snapshot.priceVersionId, chargedCredits, breakdown: toInputJson(breakdown),
    } });
    const wallet = await transaction.wallet.update({ where: { userId }, data: {
      reservedCredits: { decrement: estimatedCredits }, lifetimeConsumed: { increment: chargedCredits },
      ...(refund.gt(0) ? { availableCredits: { increment: refund } } : {}),
    } });
    await transaction.walletLedger.create({ data: {
      userId, requestId, type: 'CHARGE', amount: chargedCredits,
      balanceAfter: wallet.availableCredits, description: '图片操作结算',
    } });
    if (refund.gt(0)) await transaction.walletLedger.create({ data: {
      userId, requestId, type: 'RELEASE', amount: refund,
      balanceAfter: wallet.availableCredits, description: '图片操作释放剩余预扣',
    } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Only a definite rejection or terminal failure may refund the reservation. */
export async function releaseOperationCredits(
  prisma: PrismaClient, userId: string, requestId: string, failedJournal: Prisma.InputJsonObject,
) {
  await prisma.$transaction(async transaction => {
    const request = await transaction.aiRequest.findUnique({ where: { id: requestId } });
    if (!request || request.userId !== userId || request.capability !== 'IMAGE'
      || !['RESERVED', 'PROCESSING'].includes(request.status)) return;
    const currentJournal = journalRecord(request.result);
    if (!currentJournal || currentJournal.imageOperationVersion !== 1 || failedJournal.imageOperationVersion !== 1
      || currentJournal.taskId !== failedJournal.taskId
      || ['fingerprint', 'providerId', 'routeId', 'submittedModel', 'receiptKey', 'operation', 'speed']
        .some(key => currentJournal[key] !== failedJournal[key])) {
      throw new CloudAiError('image_operation_identity_mismatch', '原操作回执已变化，需重新查询原任务', 409);
    }
    const claimed = await transaction.aiRequest.updateMany({
      where: { id: requestId, userId, status: { in: ['RESERVED', 'PROCESSING'] } },
      data: { status: 'FAILED', chargedCredits: creditDecimal(0), result: failedJournal, completedAt: new Date() },
    });
    if (claimed.count !== 1) return;
    const credits = creditDecimal(request.estimatedCredits);
    const wallet = await transaction.wallet.update({ where: { userId }, data: {
      availableCredits: { increment: credits }, reservedCredits: { decrement: credits },
    } });
    await transaction.walletLedger.create({ data: {
      userId, requestId, type: 'RELEASE', amount: credits,
      balanceAfter: wallet.availableCredits, description: '图片操作失败，释放预扣',
    } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
