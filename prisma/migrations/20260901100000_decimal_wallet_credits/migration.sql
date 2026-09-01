ALTER TABLE "Wallet"
  ALTER COLUMN "availableCredits" TYPE DECIMAL(24,6) USING "availableCredits"::DECIMAL(24,6),
  ALTER COLUMN "reservedCredits" TYPE DECIMAL(24,6) USING "reservedCredits"::DECIMAL(24,6),
  ALTER COLUMN "lifetimeGranted" TYPE DECIMAL(24,6) USING "lifetimeGranted"::DECIMAL(24,6),
  ALTER COLUMN "lifetimeConsumed" TYPE DECIMAL(24,6) USING "lifetimeConsumed"::DECIMAL(24,6);

ALTER TABLE "WalletLedger"
  ALTER COLUMN "amount" TYPE DECIMAL(24,6) USING "amount"::DECIMAL(24,6),
  ALTER COLUMN "balanceAfter" TYPE DECIMAL(24,6) USING "balanceAfter"::DECIMAL(24,6);

ALTER TABLE "CreditRedemptionCode"
  ALTER COLUMN "credits" TYPE DECIMAL(24,6) USING "credits"::DECIMAL(24,6);

ALTER TABLE "CreditRedemption"
  ALTER COLUMN "credits" TYPE DECIMAL(24,6) USING "credits"::DECIMAL(24,6);

ALTER TABLE "AiRequest"
  ALTER COLUMN "estimatedCredits" TYPE DECIMAL(24,6) USING "estimatedCredits"::DECIMAL(24,6),
  ALTER COLUMN "chargedCredits" TYPE DECIMAL(24,6) USING "chargedCredits"::DECIMAL(24,6);

ALTER TABLE "AdminOperation"
  ALTER COLUMN "amount" TYPE DECIMAL(24,6) USING "amount"::DECIMAL(24,6);
