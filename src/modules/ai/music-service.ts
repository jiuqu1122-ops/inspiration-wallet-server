import { Prisma, type AiRequest, type PrismaClient } from '@prisma/client';
import { decryptProviderSecrets } from '../../lib/provider-secrets.js';
import { assertPublicProviderUrl } from '../providers/url.js';
import { creditDecimal, serializeCredit } from '../wallets/credit-amount.js';
import { resolveCatalogModel, ModelCatalogError } from './model-catalog.js';
import { calculateSnapshotCharge, capturePricingSnapshot, toInputJson, type PricingSnapshot } from './pricing-center.js';
import { CloudAiError } from './service.js';
import { MusicUpstreamError, submitMusic } from './music-adapter.js';
import { assertAudioResultStorageConfigured, createAudioStorageToken, mirrorGeneratedAudioResultToStorage, type StoredAudioAsset } from './audio-result-store.js';

export type MusicInput = { userId: string; clientRequestId: string; model: string; prompt: string };

type MusicReceipt = { kind: 'music_storage_pending'; tracks: Array<{ source: string; token: string; asset?: StoredAudioAsset }> };

function readReceipt(request: AiRequest): MusicReceipt | null {
  const receipt = request.result as unknown as MusicReceipt | null;
  return receipt?.kind === 'music_storage_pending' && Array.isArray(receipt.tracks) && receipt.tracks.length > 0 ? receipt : null;
}

async function storeAndSettleMusic(prisma: PrismaClient, request: AiRequest, receipt: MusicReceipt) {
  const snapshot = request.pricingSnapshot as unknown as PricingSnapshot;
  const charge = calculateSnapshotCharge(snapshot);
  const credits = creditDecimal(charge.totalCredits);
  try {
    for (const [index, track] of receipt.tracks.entries()) {
      if (!track.asset) {
        const asset = await mirrorGeneratedAudioResultToStorage(track.source, track.token);
        track.asset = { ...asset, name: `音乐 ${index + 1}.${asset.name.split('.').pop()}` };
        await prisma.$transaction(tx => tx.aiRequest.updateMany({
          where: { id: request.id, status: 'PROCESSING' }, data: { result: toInputJson(receipt) },
        }));
      }
    }
  } catch {
    // The provider has already succeeded. Only downloading/uploading may be retried.
    throw new CloudAiError('music_storage_pending', 'Music was generated; audio storage is pending. Recover this request without submitting new music.', 503);
  }
  const assets = receipt.tracks.map(track => track.asset!);
  const result = { type: 'audio' as const, content: '', assets, audioUrls: assets.map(asset => asset.url), model: snapshot.canonicalModelKey, chargedCredits: serializeCredit(credits) };
  return prisma.$transaction(async tx => {
    const claimed = await tx.aiRequest.updateMany({ where: { id: request.id, status: 'PROCESSING' }, data: { status: 'SUCCEEDED', chargedCredits: credits, result: toInputJson(result), chargeBreakdown: toInputJson(charge), completedAt: new Date() } });
    if (claimed.count !== 1) {
      const existing = await tx.aiRequest.findUnique({ where: { id: request.id } });
      if (existing?.status === 'SUCCEEDED') return existing.result;
      throw new CloudAiError('music_settlement_pending', 'Music settlement requires confirmation', 503);
    }
    await tx.wallet.update({ where: { userId: request.userId }, data: { reservedCredits: { decrement: credits } } });
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: request.userId } });
    await tx.walletLedger.create({ data: { userId: request.userId, requestId: request.id, type: 'CHARGE', amount: credits.negated(), balanceAfter: wallet.availableCredits, description: 'Music request charge' } });
    await tx.aiBillingSettlement.create({ data: { requestId: request.id, canonicalModelId: snapshot.canonicalModelId, routeId: snapshot.routeId, priceVersionId: snapshot.priceVersionId, breakdown: toInputJson(charge), chargedCredits: credits } });
    return result;
  });
}

function findMusicRequest(prisma: PrismaClient, userId: string, clientRequestId: string) {
  return prisma.$transaction(tx => tx.aiRequest.findUnique({ where: { userId_clientRequestId: { userId, clientRequestId } } }));
}

export async function getWalletMusicGenerationByRequest(prisma: PrismaClient, userId: string, clientRequestId: string) {
  const request = await findMusicRequest(prisma, userId, clientRequestId);
  if (!request || request.capability !== 'AUDIO') throw new CloudAiError('not_found', 'Music request not found', 404);
  if (request.status === 'SUCCEEDED') return request.result;
  const receipt = readReceipt(request);
  if (request.status === 'PROCESSING' && receipt) return storeAndSettleMusic(prisma, request, receipt);
  return { status: request.status.toLowerCase(), clientRequestId };
}

export async function executeWalletMusicGeneration(prisma: PrismaClient, input: MusicInput, submit = submitMusic) {
  const existing = await findMusicRequest(prisma, input.userId, input.clientRequestId);
  if (existing) {
    if (existing.capability !== 'AUDIO') throw new CloudAiError('duplicate_request', 'Request ID already in use', 409);
    if (existing.status === 'SUCCEEDED') return existing.result;
    const receipt = readReceipt(existing);
    if (existing.status === 'PROCESSING' && receipt) return storeAndSettleMusic(prisma, existing, receipt);
    throw new CloudAiError('duplicate_request', 'Music request already submitted; automatic resubmission is disabled', 409);
  }
  try { assertAudioResultStorageConfigured(); } catch {
    throw new CloudAiError('audio_storage_unavailable', 'Audio storage is not configured', 503);
  }
  const resolved = await resolveCatalogModel(prisma, input.model, 'audio', { requireEnabled: true });
  const route = resolved?.route;
  if (!resolved || !route?.channel) throw new ModelCatalogError('MODEL_ROUTE_NOT_AVAILABLE', 'No music route is available', 503);
  await assertPublicProviderUrl(route.channel.baseUrl);
  const snapshot = await capturePricingSnapshot(prisma, resolved.model, route.id, {}, input.userId);
  const charge = calculateSnapshotCharge(snapshot);
  const credits = creditDecimal(charge.totalCredits);
  const reservation = await prisma.$transaction(async tx => {
    const existing = await tx.aiRequest.findUnique({ where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } } });
    if (existing) throw new CloudAiError('duplicate_request', 'Music request already submitted; automatic resubmission is disabled', 409);
    const updated = await tx.wallet.updateMany({ where: { userId: input.userId, availableCredits: { gte: credits } }, data: { availableCredits: { decrement: credits }, reservedCredits: { increment: credits } } });
    if (updated.count !== 1) throw new CloudAiError('insufficient_credits', 'Insufficient wallet balance', 402);
    const request = await tx.aiRequest.create({ data: {
      userId: input.userId, clientRequestId: input.clientRequestId, capability: 'AUDIO', logicalModel: resolved.model.canonicalModelKey,
      canonicalModelId: resolved.model.id, routeId: route.id, priceVersionId: snapshot.priceVersionId,
      pricingSnapshot: toInputJson(snapshot), estimatedCredits: credits, status: 'PROCESSING',
    } });
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
    await tx.walletLedger.create({ data: { userId: input.userId, requestId: request.id, type: 'RESERVE', amount: credits.negated(), balanceAfter: wallet.availableCredits, description: 'Music request reservation' } });
    return request;
  });
  let audio: Awaited<ReturnType<typeof submitMusic>>;
  try {
    audio = await submit(route.channel.baseUrl, decryptProviderSecrets(route.channel.encryptedSecrets), route.upstreamModelId, input.prompt);
  } catch (error) {
    if (!(error instanceof MusicUpstreamError) || error.uncertain) {
      throw new CloudAiError('music_submission_uncertain', 'Music result requires confirmation; this request will not be submitted again', 503);
    }
    await prisma.$transaction(async tx => {
      const claimed = await tx.aiRequest.updateMany({ where: { id: reservation.id, status: 'PROCESSING' }, data: { status: 'FAILED', completedAt: new Date(), result: Prisma.DbNull } });
      if (claimed.count !== 1) return;
      await tx.wallet.update({ where: { userId: input.userId }, data: { availableCredits: { increment: credits }, reservedCredits: { decrement: credits } } });
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: input.userId } });
      await tx.walletLedger.create({ data: { userId: input.userId, requestId: reservation.id, type: 'RELEASE', amount: credits, balanceAfter: wallet.availableCredits, description: 'Music request rejected' } });
    });
    throw new CloudAiError('music_provider_rejected', 'Music provider rejected the request', 502);
  }
  const receipt: MusicReceipt = { kind: 'music_storage_pending', tracks: audio.audioUrls.map(source => ({ source, token: createAudioStorageToken() })) };
  await prisma.$transaction(tx => tx.aiRequest.updateMany({ where: { id: reservation.id, status: 'PROCESSING' }, data: { result: toInputJson(receipt) } }));
  return storeAndSettleMusic(prisma, reservation, receipt);
}
