CREATE TYPE "GroupRideGenderPreference" AS ENUM ('ANY', 'WOMEN_ONLY', 'MEN_ONLY');

ALTER TABLE "GroupRideMatchRequest"
ADD COLUMN "genderPreference" "GroupRideGenderPreference" NOT NULL DEFAULT 'ANY';

CREATE INDEX "GroupRideMatchRequest_genderPreference_status_idx"
ON "GroupRideMatchRequest"("genderPreference", "status");
