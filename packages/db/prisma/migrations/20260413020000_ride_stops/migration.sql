CREATE TYPE "RideStopType" AS ENUM ('INTERMEDIATE', 'FINAL');

CREATE TYPE "RideStopStatus" AS ENUM ('PENDING', 'COMPLETED', 'SKIPPED');

CREATE TABLE "RideStop" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "stopOrder" INTEGER NOT NULL,
    "type" "RideStopType" NOT NULL DEFAULT 'INTERMEDIATE',
    "status" "RideStopStatus" NOT NULL DEFAULT 'PENDING',
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "address" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RideStop_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RideStop_rideId_stopOrder_key" ON "RideStop"("rideId", "stopOrder");

CREATE INDEX "RideStop_rideId_status_stopOrder_idx" ON "RideStop"("rideId", "status", "stopOrder");

ALTER TABLE "RideStop" ADD CONSTRAINT "RideStop_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;
