ALTER TABLE "User"
ADD COLUMN "email" TEXT,
ADD COLUMN "displayName" TEXT,
ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN "entitlementExpiresAt" TIMESTAMP(3),
ADD COLUMN "entitlementEdition" "LicenseEdition" NOT NULL DEFAULT 'ENTERPRISE',
ADD COLUMN "entitlementFeatures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TYPE "AdminOperationType" ADD VALUE 'UPDATE_AUTHORIZATION';

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "EmailVerificationChallenge" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT,
  CONSTRAINT "EmailVerificationChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailVerificationChallenge_email_createdAt_idx"
ON "EmailVerificationChallenge"("email", "createdAt");

CREATE INDEX "EmailVerificationChallenge_expiresAt_idx"
ON "EmailVerificationChallenge"("expiresAt");

ALTER TABLE "EmailVerificationChallenge"
ADD CONSTRAINT "EmailVerificationChallenge_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "License"
SET "edition" = 'ENTERPRISE'
WHERE "edition" IN ('TRIAL', 'PRO');

UPDATE "User" AS users
SET
  "displayName" = latest."customer",
  "entitlementExpiresAt" = latest."expiresAt",
  "entitlementEdition" = 'ENTERPRISE',
  "entitlementFeatures" = ARRAY['*']::TEXT[]
FROM (
  SELECT DISTINCT ON ("userId")
    "userId",
    "customer",
    "expiresAt"
  FROM "License"
  ORDER BY "userId", "expiresAt" DESC NULLS LAST, "updatedAt" DESC
) AS latest
WHERE users."id" = latest."userId";
