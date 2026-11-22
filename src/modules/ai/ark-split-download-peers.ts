import type { LookupAddress } from 'node:dns';

export const arkSplitDownloadHost = 'ark-acg-cn-beijing.tos-cn-beijing.volces.com';
// This edge completed a ranged transfer quickly from the production worker.
const preferredAddress = '36.144.112.108';
const preferenceTtlMs = 10 * 60_000;
const retryAfter = new Map<string, number>();
let lastBackup: { address: string; expiresAt: number } | undefined;

/** Reorder only the current, validated DNS answers for the Beijing Ark result host. */
export function orderArkSplitPeers(addresses: LookupAddress[]) {
  const now = Date.now();
  const ready = addresses.filter(peer => (retryAfter.get(peer.address) ?? 0) <= now);
  if (!ready.length) return addresses;
  const preferred = [preferredAddress];
  if (lastBackup && lastBackup.expiresAt > now) preferred.push(lastBackup.address);
  return [
    ...preferred.flatMap(address => ready.filter(peer => peer.address === address)),
    ...ready.filter(peer => !preferred.includes(peer.address)),
  ];
}

export function recordArkSplitPeerSuccess(address: string) {
  retryAfter.delete(address);
  if (address !== preferredAddress) lastBackup = { address, expiresAt: Date.now() + preferenceTtlMs };
}

export function recordArkSplitPeerFailure(address: string) {
  if (lastBackup?.address === address) lastBackup = undefined;
  retryAfter.delete(address);
  retryAfter.set(address, Date.now() + preferenceTtlMs);
  // Keep the worker's history bounded as DNS rotates the edge addresses.
  if (retryAfter.size > 32) retryAfter.delete(retryAfter.keys().next().value!);
}
