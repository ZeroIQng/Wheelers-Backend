CREATE TYPE "RideHoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CHARGED');

CREATE TABLE "RideHold" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "amountUsdt" DECIMAL(18,6) NOT NULL,
    "status" "RideHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "settledAmountUsdt" DECIMAL(18,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "RideHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RideHold_rideId_key" ON "RideHold"("rideId");
CREATE INDEX "RideHold_walletId_status_idx" ON "RideHold"("walletId", "status");
CREATE INDEX "RideHold_riderId_status_idx" ON "RideHold"("riderId", "status");

ALTER TABLE "RideHold" ADD CONSTRAINT "RideHold_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
