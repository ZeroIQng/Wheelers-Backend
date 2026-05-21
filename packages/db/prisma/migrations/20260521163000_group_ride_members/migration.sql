ALTER TABLE "GroupRideMatchRequest"
ADD COLUMN "groupId" TEXT,
ADD COLUMN "matchedRideIds" JSONB;

CREATE INDEX "GroupRideMatchRequest_groupId_status_updatedAt_idx"
ON "GroupRideMatchRequest"("groupId", "status", "updatedAt");
