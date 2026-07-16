-- Store the customer label from signed licenses for administrator lookup.
ALTER TABLE "License" ADD COLUMN "customer" TEXT;

-- Idempotent administrator actions and their immutable audit result.
CREATE TYPE "AdminOperationType" AS ENUM ('PROVISION_LICENSE', 'GRANT_CREDITS');

CREATE TABLE "AdminOperation" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" "AdminOperationType" NOT NULL,
    "userId" TEXT,
    "amount" BIGINT,
    "description" TEXT,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminOperation_idempotencyKey_key" ON "AdminOperation"("idempotencyKey");
CREATE INDEX "AdminOperation_userId_createdAt_idx" ON "AdminOperation"("userId", "createdAt");
CREATE INDEX "AdminOperation_type_createdAt_idx" ON "AdminOperation"("type", "createdAt");

ALTER TABLE "AdminOperation"
ADD CONSTRAINT "AdminOperation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
