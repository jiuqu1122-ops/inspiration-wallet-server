CREATE TABLE "RechargeSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RechargeSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RechargeSession_tokenHash_key" ON "RechargeSession"("tokenHash");
CREATE INDEX "RechargeSession_userId_createdAt_idx" ON "RechargeSession"("userId", "createdAt");
CREATE INDEX "RechargeSession_expiresAt_idx" ON "RechargeSession"("expiresAt");

ALTER TABLE "RechargeSession"
ADD CONSTRAINT "RechargeSession_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
