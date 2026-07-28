CREATE TYPE "InspirationShareKind" AS ENUM ('NODE_PRESET', 'WORKFLOW');

CREATE TYPE "InspirationShareStatus" AS ENUM ('PENDING', 'PUBLISHED', 'REJECTED');

CREATE TABLE "InspirationShare" (
    "id" TEXT NOT NULL,
    "kind" "InspirationShareKind" NOT NULL,
    "status" "InspirationShareStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "authorName" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fileName" TEXT NOT NULL,
    "jsonPayload" JSONB NOT NULL,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "InspirationShare_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InspirationShare_nonnegative_downloads" CHECK ("downloadCount" >= 0)
);

CREATE TABLE "InspirationSharePreview" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspirationSharePreview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InspirationSharePreview_valid_dimensions" CHECK ("width" > 0 AND "height" > 0),
    CONSTRAINT "InspirationSharePreview_valid_size" CHECK ("sizeBytes" > 0),
    CONSTRAINT "InspirationSharePreview_valid_order" CHECK ("sortOrder" >= 0)
);

CREATE UNIQUE INDEX "InspirationSharePreview_objectKey_key" ON "InspirationSharePreview"("objectKey");
CREATE INDEX "InspirationShare_status_createdAt_idx" ON "InspirationShare"("status", "createdAt");
CREATE INDEX "InspirationShare_kind_status_createdAt_idx" ON "InspirationShare"("kind", "status", "createdAt");
CREATE INDEX "InspirationSharePreview_shareId_sortOrder_idx" ON "InspirationSharePreview"("shareId", "sortOrder");

ALTER TABLE "InspirationSharePreview"
ADD CONSTRAINT "InspirationSharePreview_shareId_fkey"
FOREIGN KEY ("shareId") REFERENCES "InspirationShare"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
