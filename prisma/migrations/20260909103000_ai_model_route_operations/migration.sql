-- Allow an upstream route to remain intact while it is waiting for an explicit
-- Canonical Model mapping. The route identity, upstream model id, cost, sync
-- metadata and cost history are deliberately preserved.
ALTER TABLE "AiModelRoute"
ALTER COLUMN "canonicalModelId" DROP NOT NULL;

-- AI Model Center operations use the existing immutable administrator audit
-- table. No credential or provider secret is stored in these records.
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'ROUTE_REMAPPED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'ROUTE_UNMAPPED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'ROUTE_DISABLED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'DEFAULT_ROUTE_CHANGED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'MODEL_VISIBILITY_CHANGED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'MODEL_ENABLED_CHANGED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'PRICING_PENDING_UPDATED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'PRICING_PUBLISHED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'MODEL_ALIAS_CREATED';
ALTER TYPE "AdminOperationType" ADD VALUE IF NOT EXISTS 'MODEL_ALIAS_DELETED';
