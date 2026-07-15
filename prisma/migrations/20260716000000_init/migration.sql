CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
CREATE TYPE "WalletLedgerType" AS ENUM ('GRANT', 'RESERVE', 'RELEASE', 'CHARGE', 'REFUND', 'ADJUSTMENT');
CREATE TYPE "AiCapability" AS ENUM ('LLM', 'IMAGE', 'VIDEO');
CREATE TYPE "AiRequestStatus" AS ENUM ('PENDING', 'RESERVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Wallet" (
    "userId" TEXT NOT NULL,
    "availableCredits" BIGINT NOT NULL DEFAULT 0,
    "reservedCredits" BIGINT NOT NULL DEFAULT 0,
    "lifetimeGranted" BIGINT NOT NULL DEFAULT 0,
    "lifetimeConsumed" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "Wallet_nonnegative_credits" CHECK (
      "availableCredits" >= 0 AND "reservedCredits" >= 0 AND
      "lifetimeGranted" >= 0 AND "lifetimeConsumed" >= 0
    )
);

CREATE TABLE "AiRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "capability" "AiCapability" NOT NULL,
    "logicalModel" TEXT NOT NULL,
    "status" "AiRequestStatus" NOT NULL DEFAULT 'PENDING',
    "estimatedCredits" BIGINT NOT NULL DEFAULT 0,
    "chargedCredits" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "AiRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiRequest_nonnegative_credits" CHECK ("estimatedCredits" >= 0 AND "chargedCredits" >= 0)
);

CREATE TABLE "WalletLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT,
    "type" "WalletLedgerType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletLedger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WalletLedger_nonnegative_balance" CHECK ("balanceAfter" >= 0)
);

CREATE INDEX "User_status_idx" ON "User"("status");
CREATE UNIQUE INDEX "License_codeHash_key" ON "License"("codeHash");
CREATE INDEX "License_userId_status_idx" ON "License"("userId", "status");
CREATE INDEX "License_expiresAt_idx" ON "License"("expiresAt");
CREATE INDEX "WalletLedger_userId_createdAt_idx" ON "WalletLedger"("userId", "createdAt");
CREATE INDEX "WalletLedger_requestId_idx" ON "WalletLedger"("requestId");
CREATE UNIQUE INDEX "AiRequest_userId_clientRequestId_key" ON "AiRequest"("userId", "clientRequestId");
CREATE INDEX "AiRequest_userId_createdAt_idx" ON "AiRequest"("userId", "createdAt");
CREATE INDEX "AiRequest_status_createdAt_idx" ON "AiRequest"("status", "createdAt");

ALTER TABLE "License" ADD CONSTRAINT "License_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiRequest" ADD CONSTRAINT "AiRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletLedger" ADD CONSTRAINT "WalletLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletLedger" ADD CONSTRAINT "WalletLedger_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AiRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
