-- Add the signed-license claims needed by the cloud session layer. All new
-- scalar claims are nullable so this migration remains safe if a database has
-- License rows created before cloud login existed.
CREATE TYPE "LicenseEdition" AS ENUM ('TRIAL', 'PRO', 'ENTERPRISE');

ALTER TABLE "License"
ADD COLUMN "machineIdHash" TEXT,
ADD COLUMN "edition" "LicenseEdition",
ADD COLUMN "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "lastExchangedAt" TIMESTAMP(3);

CREATE INDEX "License_machineIdHash_createdAt_idx" ON "License"("machineIdHash", "createdAt");

CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");
CREATE INDEX "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");
CREATE INDEX "AuthSession_licenseId_revokedAt_idx" ON "AuthSession"("licenseId", "revokedAt");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
