CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'REVOKED');

ALTER TABLE "AuthSession" ALTER COLUMN "licenseId" DROP NOT NULL;

CREATE TABLE "MembershipPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MembershipPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MembershipPlanVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prices" JSONB NOT NULL,
    "freeQuota" JSONB,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MembershipPlanVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ADMIN',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserMembership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralProfile" (
    "userId" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReferralProfile_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "ReferralRelation" (
    "id" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferralRelation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralRewardRule" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "inviterCredits" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "inviteeCredits" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "minRecharge" DECIMAL(24,6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReferralRewardRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReferralRewardEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "ruleId" TEXT,
    "relationId" TEXT,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "inviterCredits" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "inviteeCredits" DECIMAL(24,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferralRewardEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MembershipPlan_code_key" ON "MembershipPlan"("code");
CREATE INDEX "MembershipPlan_active_updatedAt_idx" ON "MembershipPlan"("active", "updatedAt");
CREATE UNIQUE INDEX "MembershipPlanVersion_planId_version_key" ON "MembershipPlanVersion"("planId", "version");
CREATE INDEX "MembershipPlanVersion_planId_publishedAt_idx" ON "MembershipPlanVersion"("planId", "publishedAt");
CREATE INDEX "UserMembership_userId_status_expiresAt_idx" ON "UserMembership"("userId", "status", "expiresAt");
CREATE INDEX "UserMembership_planId_status_expiresAt_idx" ON "UserMembership"("planId", "status", "expiresAt");
CREATE UNIQUE INDEX "ReferralProfile_inviteCode_key" ON "ReferralProfile"("inviteCode");
CREATE UNIQUE INDEX "ReferralRelation_inviteeId_key" ON "ReferralRelation"("inviteeId");
CREATE INDEX "ReferralRelation_inviterId_boundAt_idx" ON "ReferralRelation"("inviterId", "boundAt");
CREATE INDEX "ReferralRelation_inviteCode_boundAt_idx" ON "ReferralRelation"("inviteCode", "boundAt");
CREATE UNIQUE INDEX "ReferralRewardRule_eventType_key" ON "ReferralRewardRule"("eventType");
CREATE UNIQUE INDEX "ReferralRewardEvent_eventKey_key" ON "ReferralRewardEvent"("eventKey");
CREATE INDEX "ReferralRewardEvent_inviterId_createdAt_idx" ON "ReferralRewardEvent"("inviterId", "createdAt");
CREATE INDEX "ReferralRewardEvent_inviteeId_createdAt_idx" ON "ReferralRewardEvent"("inviteeId", "createdAt");
CREATE INDEX "ReferralRewardEvent_relationId_createdAt_idx" ON "ReferralRewardEvent"("relationId", "createdAt");

ALTER TABLE "MembershipPlanVersion" ADD CONSTRAINT "MembershipPlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserMembership" ADD CONSTRAINT "UserMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserMembership" ADD CONSTRAINT "UserMembership_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralProfile" ADD CONSTRAINT "ReferralProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralRelation" ADD CONSTRAINT "ReferralRelation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralRelation" ADD CONSTRAINT "ReferralRelation_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralRewardEvent" ADD CONSTRAINT "ReferralRewardEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ReferralRewardRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReferralRewardEvent" ADD CONSTRAINT "ReferralRewardEvent_relationId_fkey" FOREIGN KEY ("relationId") REFERENCES "ReferralRelation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReferralRewardEvent" ADD CONSTRAINT "ReferralRewardEvent_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReferralRewardEvent" ADD CONSTRAINT "ReferralRewardEvent_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing accounts receive an invite code lazily through the service. This keeps
-- the migration safe for large installations and avoids locking the User table.
INSERT INTO "ReferralRewardRule" ("id", "eventType", "inviterCredits", "inviteeCredits", "active", "updatedAt")
VALUES ('ref_registration_default', 'REGISTRATION', 100, 100, true, CURRENT_TIMESTAMP)
ON CONFLICT ("eventType") DO NOTHING;
