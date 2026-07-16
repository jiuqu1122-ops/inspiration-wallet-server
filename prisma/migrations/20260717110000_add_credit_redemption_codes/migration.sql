CREATE TYPE "CreditRedemptionCodeStatus" AS ENUM ('ACTIVE', 'DISABLED');

ALTER TABLE "AiProviderChannel" ADD COLUMN "defaultModel" TEXT;

CREATE TABLE "CreditRedemptionCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeHint" TEXT NOT NULL,
    "credits" BIGINT NOT NULL,
    "maxRedemptions" INTEGER NOT NULL DEFAULT 1,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "CreditRedemptionCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditRedemptionCode_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditRedemptionCode_positive_credits" CHECK ("credits" > 0),
    CONSTRAINT "CreditRedemptionCode_positive_limit" CHECK ("maxRedemptions" > 0),
    CONSTRAINT "CreditRedemptionCode_valid_count" CHECK ("redeemedCount" >= 0 AND "redeemedCount" <= "maxRedemptions")
);

CREATE TABLE "CreditRedemption" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credits" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditRedemption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditRedemption_positive_credits" CHECK ("credits" > 0)
);

CREATE UNIQUE INDEX "CreditRedemptionCode_codeHash_key" ON "CreditRedemptionCode"("codeHash");
CREATE INDEX "CreditRedemptionCode_status_expiresAt_idx" ON "CreditRedemptionCode"("status", "expiresAt");
CREATE INDEX "CreditRedemptionCode_createdAt_idx" ON "CreditRedemptionCode"("createdAt");
CREATE UNIQUE INDEX "CreditRedemption_codeId_userId_key" ON "CreditRedemption"("codeId", "userId");
CREATE INDEX "CreditRedemption_userId_createdAt_idx" ON "CreditRedemption"("userId", "createdAt");

ALTER TABLE "CreditRedemption"
ADD CONSTRAINT "CreditRedemption_codeId_fkey"
FOREIGN KEY ("codeId") REFERENCES "CreditRedemptionCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CreditRedemption"
ADD CONSTRAINT "CreditRedemption_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
