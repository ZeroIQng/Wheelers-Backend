-- Track referral cashback ride reservations so discounts can be released on cancel
-- and settled only after the ride completes.
CREATE TYPE "ReferralCashbackUsageStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

ALTER TABLE "ReferralCashbackUsage"
  ADD COLUMN "status" "ReferralCashbackUsageStatus" NOT NULL DEFAULT 'RESERVED',
  ADD COLUMN "settledAt" TIMESTAMP(3),
  ADD COLUMN "releasedAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "ReferralCashbackUsage_rideId_idx";
CREATE INDEX "ReferralCashbackUsage_rideId_status_idx" ON "ReferralCashbackUsage"("rideId", "status");

ALTER TABLE "ReferralCashbackUsage"
  ADD CONSTRAINT "ReferralCashbackUsage_rideId_fkey"
  FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE SET NULL ON UPDATE CASCADE;
