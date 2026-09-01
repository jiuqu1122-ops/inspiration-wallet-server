import { PrismaClient } from '@prisma/client';
import { creditDecimal, serializeCredit } from '../modules/wallets/credit-amount.js';

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const userId = argument('user');
const rawAmount = argument('amount');
const description = argument('description')?.trim() || 'Manual server grant';

if (!userId || !rawAmount || !/^\d+$/.test(rawAmount)) {
  throw new Error(
    'Usage: npm run credits:grant -- --user=<userId> --amount=<positive integer> [--description=<text>]',
  );
}

const amount = BigInt(rawAmount);
if (amount <= 0n || description.length > 500) {
  throw new Error('Amount must be positive and description must not exceed 500 characters');
}

const prisma = new PrismaClient();
const decimalAmount = creditDecimal(amount);

try {
  const result = await prisma.$transaction(async (transaction) => {
    const wallet = await transaction.wallet.update({
      where: { userId },
      data: {
        availableCredits: { increment: decimalAmount },
        lifetimeGranted: { increment: decimalAmount },
      },
      select: { availableCredits: true },
    });
    const ledger = await transaction.walletLedger.create({
      data: {
        userId,
        type: 'GRANT',
        amount: decimalAmount,
        balanceAfter: wallet.availableCredits,
        description,
      },
      select: { id: true, createdAt: true },
    });
    return { wallet, ledger };
  });

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      userId,
      grantedCredits: serializeCredit(decimalAmount),
      balanceAfter: serializeCredit(result.wallet.availableCredits),
      ledgerId: result.ledger.id,
      createdAt: result.ledger.createdAt,
    })}\n`,
  );
} finally {
  await prisma.$disconnect();
}
