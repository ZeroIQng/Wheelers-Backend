-- Emergency alerts raised by riders and drivers during a trip.

CREATE TYPE "SafetyAlertRole" AS ENUM ('RIDER', 'DRIVER');
CREATE TYPE "SafetyAlertKind" AS ENUM ('SOS', 'UNSAFE_DRIVING', 'ROUTE_DEVIATION', 'ACCIDENT', 'MEDICAL');
CREATE TYPE "SafetyAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED');

CREATE TABLE "SafetyAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "raisedByRole" "SafetyAlertRole" NOT NULL,
    "kind" "SafetyAlertKind" NOT NULL DEFAULT 'SOS',
    "status" "SafetyAlertStatus" NOT NULL DEFAULT 'OPEN',
    "rideId" TEXT,
    "interstateDepartureId" TEXT,
    "counterpartUserId" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "address" TEXT,
    "note" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "handledBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SafetyAlert_status_createdAt_idx" ON "SafetyAlert"("status", "createdAt");
CREATE INDEX "SafetyAlert_userId_createdAt_idx" ON "SafetyAlert"("userId", "createdAt");
CREATE INDEX "SafetyAlert_rideId_idx" ON "SafetyAlert"("rideId");

ALTER TABLE "SafetyAlert" ADD CONSTRAINT "SafetyAlert_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
