import { PrismaClient } from '@prisma/client';

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

try {
  const result = await prisma.$transaction(async (transaction) => {
    const wallet = await transaction.wallet.update({
      where: { userId },
      data: {
        availableCredits: { increment: amount },
        lifetimeGranted: { increment: amount },
      },
      select: { availableCredits: true },
    });
    const ledger = await transaction.walletLedger.create({
      data: {
        userId,
        type: 'GRANT',
        amount,
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
      grantedCredits: amount.toString(),
      balanceAfter: result.wallet.availableCredits.toString(),
      ledgerId: result.ledger.id,
      createdAt: result.ledger.createdAt,
    })}\n`,
  );
} finally {
  await prisma.$disconnect();
}
