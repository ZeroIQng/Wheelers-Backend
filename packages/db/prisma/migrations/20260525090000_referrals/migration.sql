-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED_RIDE', 'EXPIRED_NO_RIDE', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReferralCashbackType" AS ENUM ('RIDE_QUALIFIED', 'NO_RIDE_EXPIRED');

-- CreateEnum
CREATE TYPE "ReferralCashbackStatus" AS ENUM ('AVAILABLE', 'FROZEN', 'USED', 'EXPIRED');

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "firstRideId" TEXT,
    "qualifiedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "usedToUnlockCashbackId" TEXT,
    "unlockedAmountNgn" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCashback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceReferralId" TEXT,
    "type" "ReferralCashbackType" NOT NULL,
    "amountNgn" DECIMAL(18,2) NOT NULL,
    "remainingAmountNgn" DECIMAL(18,2) NOT NULL,
    "status" "ReferralCashbackStatus" NOT NULL DEFAULT 'AVAILABLE',
    "freezesAt" TIMESTAMP(3) NOT NULL,
    "frozenAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCashback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCashbackUsage" (
    "id" TEXT NOT NULL,
    "cashbackId" TEXT NOT NULL,
    "rideId" TEXT,
    "amountNgn" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCashbackUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCashbackUnlock" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "cashbackId" TEXT NOT NULL,
    "amountNgn" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCashbackUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_userId_key" ON "ReferralCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

-- CreateIndex
CREATE INDEX "ReferralCode_code_isActive_idx" ON "ReferralCode"("code", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referredUserId_key" ON "Referral"("referredUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_usedToUnlockCashbackId_key" ON "Referral"("usedToUnlockCashbackId");

-- CreateIndex
CREATE INDEX "Referral_referrerId_status_appliedAt_idx" ON "Referral"("referrerId", "status", "appliedAt");

-- CreateIndex
CREATE INDEX "Referral_referredUserId_status_idx" ON "Referral"("referredUserId", "status");

-- CreateIndex
CREATE INDEX "Referral_expiresAt_status_idx" ON "Referral"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "Referral_closesAt_status_idx" ON "Referral"("closesAt", "status");

-- CreateIndex
CREATE INDEX "ReferralCashback_userId_status_freezesAt_idx" ON "ReferralCashback"("userId", "status", "freezesAt");

-- CreateIndex
CREATE INDEX "ReferralCashback_sourceReferralId_idx" ON "ReferralCashback"("sourceReferralId");

-- CreateIndex
CREATE INDEX "ReferralCashbackUsage_cashbackId_idx" ON "ReferralCashbackUsage"("cashbackId");

-- CreateIndex
CREATE INDEX "ReferralCashbackUsage_rideId_idx" ON "ReferralCashbackUsage"("rideId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCashbackUnlock_referralId_cashbackId_key" ON "ReferralCashbackUnlock"("referralId", "cashbackId");

-- CreateIndex
CREATE INDEX "ReferralCashbackUnlock_cashbackId_idx" ON "ReferralCashbackUnlock"("cashbackId");

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_firstRideId_fkey" FOREIGN KEY ("firstRideId") REFERENCES "Ride"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_usedToUnlockCashbackId_fkey" FOREIGN KEY ("usedToUnlockCashbackId") REFERENCES "ReferralCashback"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCashback" ADD CONSTRAINT "ReferralCashback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCashback" ADD CONSTRAINT "ReferralCashback_sourceReferralId_fkey" FOREIGN KEY ("sourceReferralId") REFERENCES "Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCashbackUsage" ADD CONSTRAINT "ReferralCashbackUsage_cashbackId_fkey" FOREIGN KEY ("cashbackId") REFERENCES "ReferralCashback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCashbackUnlock" ADD CONSTRAINT "ReferralCashbackUnlock_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCashbackUnlock" ADD CONSTRAINT "ReferralCashbackUnlock_cashbackId_fkey" FOREIGN KEY ("cashbackId") REFERENCES "ReferralCashback"("id") ON DELETE CASCADE ON UPDATE CASCADE;
