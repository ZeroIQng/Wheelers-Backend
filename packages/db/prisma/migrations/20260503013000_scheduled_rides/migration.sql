-- CreateEnum
CREATE TYPE "ScheduledRideStatus" AS ENUM ('SCHEDULED', 'DISPATCHING', 'DISPATCHED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ScheduledRidePaymentMethod" AS ENUM ('WALLET_BALANCE', 'SMART_ACCOUNT');

-- CreateTable
CREATE TABLE "ScheduledRide" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "riderWallet" TEXT NOT NULL,
    "status" "ScheduledRideStatus" NOT NULL DEFAULT 'SCHEDULED',
    "paymentMethod" "ScheduledRidePaymentMethod" NOT NULL DEFAULT 'WALLET_BALANCE',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "requestedRideId" TEXT,
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "destLat" DOUBLE PRECISION NOT NULL,
    "destLng" DOUBLE PRECISION NOT NULL,
    "destAddress" TEXT NOT NULL,
    "stops" JSONB,
    "plannedDistanceKm" DOUBLE PRECISION,
    "plannedDurationSeconds" INTEGER,
    "fareEstimateUsdt" DECIMAL(18,6),
    "cancellationReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledRide_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledRide_requestedRideId_key" ON "ScheduledRide"("requestedRideId");

-- CreateIndex
CREATE INDEX "ScheduledRide_riderId_scheduledFor_idx" ON "ScheduledRide"("riderId", "scheduledFor");

-- CreateIndex
CREATE INDEX "ScheduledRide_status_scheduledFor_idx" ON "ScheduledRide"("status", "scheduledFor");
