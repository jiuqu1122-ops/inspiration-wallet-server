CREATE TYPE "ReferenceUploadStatus" AS ENUM ('ISSUED', 'UPLOADED');

CREATE TABLE "ReferenceUpload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "ReferenceUploadStatus" NOT NULL DEFAULT 'ISSUED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceUpload_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferenceUpload_objectKey_key" ON "ReferenceUpload"("objectKey");
CREATE INDEX "ReferenceUpload_userId_expiresAt_idx" ON "ReferenceUpload"("userId", "expiresAt");
CREATE INDEX "ReferenceUpload_userId_status_createdAt_idx" ON "ReferenceUpload"("userId", "status", "createdAt");

ALTER TABLE "ReferenceUpload"
ADD CONSTRAINT "ReferenceUpload_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
