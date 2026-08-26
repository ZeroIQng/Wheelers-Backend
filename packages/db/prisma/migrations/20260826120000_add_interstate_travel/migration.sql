-- CreateEnum
CREATE TYPE "InterstateVehicleType" AS ENUM ('SEDAN', 'SUV', 'MINIBUS', 'BUS');

-- CreateEnum
CREATE TYPE "InterstateBookingMode" AS ENUM ('SHARED', 'CHARTER');

-- CreateEnum
CREATE TYPE "InterstateDepartureStatus" AS ENUM ('SCHEDULED', 'FILLING', 'FULL', 'DISPATCHED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InterstateBookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'REFUNDED', 'COMPLETED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "InterstateRoute" (
    "id" TEXT NOT NULL,
    "originState" TEXT NOT NULL,
    "originCity" TEXT NOT NULL,
    "originTerminal" TEXT NOT NULL,
    "originLat" DOUBLE PRECISION NOT NULL,
    "originLng" DOUBLE PRECISION NOT NULL,
    "destState" TEXT NOT NULL,
    "destCity" TEXT NOT NULL,
    "destTerminal" TEXT NOT NULL,
    "destLat" DOUBLE PRECISION NOT NULL,
    "destLng" DOUBLE PRECISION NOT NULL,
    "distanceKm" DOUBLE PRECISION NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "seatPriceNgn" DECIMAL(18,2) NOT NULL,
    "charterPriceNgn" DECIMAL(18,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterstateRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterstateDeparture" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "departureAt" TIMESTAMP(3) NOT NULL,
    "vehicleType" "InterstateVehicleType" NOT NULL DEFAULT 'BUS',
    "totalSeats" INTEGER NOT NULL,
    "seatsBooked" INTEGER NOT NULL DEFAULT 0,
    "seatPriceNgn" DECIMAL(18,2) NOT NULL,
    "charterPriceNgn" DECIMAL(18,2) NOT NULL,
    "bookingMode" "InterstateBookingMode" NOT NULL DEFAULT 'SHARED',
    "minimumSeats" INTEGER NOT NULL DEFAULT 1,
    "status" "InterstateDepartureStatus" NOT NULL DEFAULT 'SCHEDULED',
    "driverId" TEXT,
    "vehiclePlate" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "departedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterstateDeparture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterstateBooking" (
    "id" TEXT NOT NULL,
    "departureId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "InterstateBookingMode" NOT NULL DEFAULT 'SHARED',
    "seats" INTEGER NOT NULL DEFAULT 1,
    "amountNgn" DECIMAL(18,2) NOT NULL,
    "refundedNgn" DECIMAL(18,2),
    "status" "InterstateBookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "passengerName" TEXT,
    "passengerPhone" TEXT,
    "pickupNote" TEXT,
    "reference" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterstateBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterstateRoute_originState_destState_active_idx" ON "InterstateRoute"("originState", "destState", "active");

-- CreateIndex
CREATE INDEX "InterstateRoute_active_originCity_idx" ON "InterstateRoute"("active", "originCity");

-- CreateIndex
CREATE UNIQUE INDEX "InterstateRoute_originCity_destCity_key" ON "InterstateRoute"("originCity", "destCity");

-- CreateIndex
CREATE INDEX "InterstateDeparture_routeId_departureAt_status_idx" ON "InterstateDeparture"("routeId", "departureAt", "status");

-- CreateIndex
CREATE INDEX "InterstateDeparture_status_departureAt_idx" ON "InterstateDeparture"("status", "departureAt");

-- CreateIndex
CREATE INDEX "InterstateDeparture_driverId_status_idx" ON "InterstateDeparture"("driverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InterstateBooking_reference_key" ON "InterstateBooking"("reference");

-- CreateIndex
CREATE INDEX "InterstateBooking_userId_status_createdAt_idx" ON "InterstateBooking"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "InterstateBooking_departureId_status_idx" ON "InterstateBooking"("departureId", "status");

-- AddForeignKey
ALTER TABLE "InterstateDeparture" ADD CONSTRAINT "InterstateDeparture_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "InterstateRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterstateDeparture" ADD CONSTRAINT "InterstateDeparture_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterstateBooking" ADD CONSTRAINT "InterstateBooking_departureId_fkey" FOREIGN KEY ("departureId") REFERENCES "InterstateDeparture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterstateBooking" ADD CONSTRAINT "InterstateBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

