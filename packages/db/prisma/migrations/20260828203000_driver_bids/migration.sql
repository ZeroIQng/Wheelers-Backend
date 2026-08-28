-- Driver bids, persisted. ride-service only ever held bids in memory for the
-- life of the auction, so once a ride was matched (or the service restarted)
-- there was no record of who offered what. Drivers get a bid history; support
-- gets an audit trail.

CREATE TYPE "DriverBidStatus" AS ENUM ('PENDING', 'ACCEPTED', 'LOST', 'WITHDRAWN', 'EXPIRED', 'CANCELLED');

CREATE TABLE "DriverBid" (
    "id"           TEXT NOT NULL,
    "rideId"       TEXT NOT NULL,
    "driverId"     TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "riderId"      TEXT NOT NULL,
    "amountNgn"    DECIMAL(18,2) NOT NULL,
    "etaSeconds"   INTEGER NOT NULL,
    "distanceKm"   DOUBLE PRECISION,
    "status"       "DriverBidStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "resolvedAt"   TIMESTAMP(3),

    CONSTRAINT "DriverBid_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriverBid_rideId_driverId_key" ON "DriverBid"("rideId", "driverId");
CREATE INDEX "DriverBid_driverId_createdAt_idx" ON "DriverBid"("driverId", "createdAt");
CREATE INDEX "DriverBid_rideId_status_idx" ON "DriverBid"("rideId", "status");

ALTER TABLE "DriverBid" ADD CONSTRAINT "DriverBid_rideId_fkey"
  FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriverBid" ADD CONSTRAINT "DriverBid_driverId_fkey"
  FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
