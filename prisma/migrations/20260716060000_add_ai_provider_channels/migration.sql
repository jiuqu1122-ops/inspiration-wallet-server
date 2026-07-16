ALTER TYPE "AdminOperationType" ADD VALUE 'CREATE_PROVIDER';
ALTER TYPE "AdminOperationType" ADD VALUE 'UPDATE_PROVIDER';

CREATE TYPE "AiProviderKind" AS ENUM ('NEW_API', 'XAIS');
CREATE TYPE "AiProviderStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "AiProviderChannel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AiProviderKind" NOT NULL,
    "status" "AiProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "baseUrl" TEXT NOT NULL,
    "encryptedSecrets" TEXT NOT NULL,
    "apiKeyLast4" TEXT NOT NULL,
    "capabilities" "AiCapability"[] NOT NULL,
    "lastTestStatus" TEXT,
    "lastTestMessage" TEXT,
    "lastTestModelCount" INTEGER,
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiProviderChannel_name_key" ON "AiProviderChannel"("name");
CREATE INDEX "AiProviderChannel_kind_status_idx" ON "AiProviderChannel"("kind", "status");
CREATE INDEX "AiProviderChannel_updatedAt_idx" ON "AiProviderChannel"("updatedAt");
