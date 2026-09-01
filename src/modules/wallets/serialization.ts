import type { Wallet } from '@prisma/client';
import { serializeCredit } from './credit-amount.js';

type WalletBalance = Pick<
  Wallet,
  'availableCredits' | 'reservedCredits' | 'lifetimeGranted' | 'lifetimeConsumed'
>;

export function serializeWalletBalance(wallet: WalletBalance) {
  return {
    availableCredits: serializeCredit(wallet.availableCredits),
    reservedCredits: serializeCredit(wallet.reservedCredits),
    lifetimeGranted: serializeCredit(wallet.lifetimeGranted),
    lifetimeConsumed: serializeCredit(wallet.lifetimeConsumed),
  };
}
