import type { Wallet } from '@prisma/client';

type WalletBalance = Pick<
  Wallet,
  'availableCredits' | 'reservedCredits' | 'lifetimeGranted' | 'lifetimeConsumed'
>;

export function serializeWalletBalance(wallet: WalletBalance) {
  return {
    availableCredits: wallet.availableCredits.toString(),
    reservedCredits: wallet.reservedCredits.toString(),
    lifetimeGranted: wallet.lifetimeGranted.toString(),
    lifetimeConsumed: wallet.lifetimeConsumed.toString(),
  };
}
