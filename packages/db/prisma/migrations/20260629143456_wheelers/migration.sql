/*
  Warnings:

  - The values [DEFI_TIER1,DEFI_TIER2,DEFI_TIER3] on the enum `ConsentType` will be removed. If these variants are still used in the database, this will fail.
  - The values [DEFI] on the enum `NotificationCategory` will be removed. If these variants are still used in the database, this will fail.
  - The values [SMART_ACCOUNT] on the enum `ScheduledRidePaymentMethod` will be removed. If these variants are still used in the database, this will fail.
  - The values [FIAT_ONRAMP,CRYPTO_DEPOSIT,YIELD_HARVEST,DEFI_STAKE,DEFI_UNSTAKE] on the enum `TransactionType` will be removed. If these variants are still used in the database, this will fail.
  - The values [OFFRAMP_CREATED] on the enum `WithdrawalRequestStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `bonusUsdt` on the `Dispute` table. All the data in the column will be lost.
  - You are about to drop the column `refundUsdt` on the `Dispute` table. All the data in the column will be lost.
  - You are about to drop the column `totalEarningsUsdt` on the `Driver` table. All the data in the column will be lost.
  - You are about to drop the column `commentHash` on the `Feedback` table. All the data in the column will be lost.
  - You are about to drop the column `onchainTxHash` on the `Feedback` table. All the data in the column will be lost.
  - You are about to drop the column `revieweeWallet` on the `Feedback` table. All the data in the column will be lost.
  - You are about to drop the column `fareEstimateUsdt` on the `GroupRideMatchRequest` table. All the data in the column will be lost.
  - You are about to drop the column `fareEstimateUsdt` on the `Ride` table. All the data in the column will be lost.
  - You are about to drop the column `fareFinalUsdt` on the `Ride` table. All the data in the column will be lost.
  - You are about to drop the column `penaltyUsdt` on the `Ride` table. All the data in the column will be lost.
  - You are about to drop the column `platformFeeUsdt` on the `Ride` table. All the data in the column will be lost.
  - You are about to drop the column `recordingCid` on the `Ride` table. All the data in the column will be lost.
  - You are about to drop the column `recordingHash` on the `Ride` table. All the data in the column will be lost.
  - You are about to drop the column `amountUsdt` on the `RideHold` table. All the data in the column will be lost.
  - You are about to drop the column `settledAmountUsdt` on the `RideHold` table. All the data in the column will be lost.
  - You are about to drop the column `fareEstimateUsdt` on the `ScheduledRide` table. All the data in the column will be lost.
  - You are about to drop the column `riderWallet` on the `ScheduledRide` table. All the data in the column will be lost.
  - You are about to drop the column `amountUsdt` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `balanceAfter` on the `Transaction` table. All the data in the column will be lost.
  - You are about to drop the column `walletAddress` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `consentTxHash` on the `UserConsent` table. All the data in the column will be lost.
  - You are about to drop the column `korapayRef` on the `VirtualAccount` table. All the data in the column will be lost.
  - You are about to drop the column `walletId` on the `VirtualAccount` table. All the data in the column will be lost.
  - You are about to drop the column `address` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `balanceUsdt` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `chain` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `lockedUsdt` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `stakedUsdt` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `amountUsdt` on the `WalletReservation` table. All the data in the column will be lost.
  - You are about to drop the column `cryptoCurrency` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `cryptoNetwork` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `displayCurrency` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `displayExchangeRate` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `paymentId` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `payoutCurrency` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `quotedAmountNgn` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `quotedAmountUsd` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `quotedCryptoAmount` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the column `reservedAmountUsdt` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - You are about to drop the `DefiPosition` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PaymentIntent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PaymentRecord` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Recording` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `YieldHarvest` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[pouchCustomerId]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId]` on the table `VirtualAccount` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[pouchVirtualAccountId]` on the table `VirtualAccount` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[pouchPayoutId]` on the table `WithdrawalRequest` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `amountNgn` to the `RideHold` table without a default value. This is not possible if the table is not empty.
  - Added the required column `amountNgn` to the `Transaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `balanceAfterNgn` to the `Transaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pouchCustomerId` to the `VirtualAccount` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pouchVirtualAccountId` to the `VirtualAccount` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `VirtualAccount` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `VirtualAccount` table without a default value. This is not possible if the table is not empty.
  - Added the required column `amountNgn` to the `WalletReservation` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reservedAmountNgn` to the `WithdrawalRequest` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ChatSenderRole" AS ENUM ('RIDER', 'DRIVER');

-- CreateEnum
CREATE TYPE "RidePaymentMethod" AS ENUM ('CASH', 'WALLET');

-- CreateEnum
CREATE TYPE "RiderKycStatus" AS ENUM ('NONE', 'PENDING', 'VERIFIED');

-- AlterEnum
BEGIN;
CREATE TYPE "ConsentType_new" AS ENUM ('RECORDING');
ALTER TABLE "UserConsent" ALTER COLUMN "consentType" TYPE "ConsentType_new" USING ("consentType"::text::"ConsentType_new");
ALTER TYPE "ConsentType" RENAME TO "ConsentType_old";
ALTER TYPE "ConsentType_new" RENAME TO "ConsentType";
DROP TYPE "ConsentType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "NotificationCategory_new" AS ENUM ('RIDE', 'PAYMENT', 'WALLET', 'DISPUTE', 'KYC', 'SYSTEM');
ALTER TABLE "Notification" ALTER COLUMN "category" TYPE "NotificationCategory_new" USING ("category"::text::"NotificationCategory_new");
ALTER TYPE "NotificationCategory" RENAME TO "NotificationCategory_old";
ALTER TYPE "NotificationCategory_new" RENAME TO "NotificationCategory";
DROP TYPE "NotificationCategory_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ScheduledRidePaymentMethod_new" AS ENUM ('WALLET_BALANCE');
ALTER TABLE "GroupRideMatchRequest" ALTER COLUMN "paymentMethod" DROP DEFAULT;
ALTER TABLE "ScheduledRide" ALTER COLUMN "paymentMethod" DROP DEFAULT;
ALTER TABLE "GroupRideMatchRequest" ALTER COLUMN "paymentMethod" TYPE "ScheduledRidePaymentMethod_new" USING ("paymentMethod"::text::"ScheduledRidePaymentMethod_new");
ALTER TABLE "ScheduledRide" ALTER COLUMN "paymentMethod" TYPE "ScheduledRidePaymentMethod_new" USING ("paymentMethod"::text::"ScheduledRidePaymentMethod_new");
ALTER TYPE "ScheduledRidePaymentMethod" RENAME TO "ScheduledRidePaymentMethod_old";
ALTER TYPE "ScheduledRidePaymentMethod_new" RENAME TO "ScheduledRidePaymentMethod";
DROP TYPE "ScheduledRidePaymentMethod_old";
ALTER TABLE "GroupRideMatchRequest" ALTER COLUMN "paymentMethod" SET DEFAULT 'WALLET_BALANCE';
ALTER TABLE "ScheduledRide" ALTER COLUMN "paymentMethod" SET DEFAULT 'WALLET_BALANCE';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TransactionType_new" AS ENUM ('DEPOSIT', 'DRIVER_PAYOUT', 'REFUND', 'DISPUTE_RESOLUTION', 'RIDE_PAYMENT', 'PENALTY', 'WITHDRAWAL');
ALTER TABLE "Transaction" ALTER COLUMN "type" TYPE "TransactionType_new" USING ("type"::text::"TransactionType_new");
ALTER TYPE "TransactionType" RENAME TO "TransactionType_old";
ALTER TYPE "TransactionType_new" RENAME TO "TransactionType";
DROP TYPE "TransactionType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "WithdrawalRequestStatus_new" AS ENUM ('PENDING', 'FUNDS_RESERVED', 'PAYOUT_CREATED', 'PROCESSING', 'SETTLED', 'FAILED', 'EXPIRED', 'CANCELLED');
ALTER TABLE "WithdrawalRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "WithdrawalRequest" ALTER COLUMN "status" TYPE "WithdrawalRequestStatus_new" USING ("status"::text::"WithdrawalRequestStatus_new");
ALTER TYPE "WithdrawalRequestStatus" RENAME TO "WithdrawalRequestStatus_old";
ALTER TYPE "WithdrawalRequestStatus_new" RENAME TO "WithdrawalRequestStatus";
DROP TYPE "WithdrawalRequestStatus_old";
ALTER TABLE "WithdrawalRequest" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "DefiPosition" DROP CONSTRAINT "DefiPosition_walletId_fkey";

-- DropForeignKey
ALTER TABLE "VirtualAccount" DROP CONSTRAINT "VirtualAccount_walletId_fkey";

-- DropForeignKey
ALTER TABLE "YieldHarvest" DROP CONSTRAINT "YieldHarvest_positionId_fkey";

-- DropIndex
DROP INDEX "User_walletAddress_idx";

-- DropIndex
DROP INDEX "User_walletAddress_key";

-- DropIndex
DROP INDEX "VirtualAccount_korapayRef_key";

-- DropIndex
DROP INDEX "VirtualAccount_walletId_key";

-- DropIndex
DROP INDEX "Wallet_address_idx";

-- DropIndex
DROP INDEX "Wallet_address_key";

-- DropIndex
DROP INDEX "WithdrawalRequest_paymentId_key";

-- AlterTable
ALTER TABLE "Dispute" DROP COLUMN "bonusUsdt",
DROP COLUMN "refundUsdt",
ADD COLUMN     "bonusNgn" DECIMAL(18,2),
ADD COLUMN     "refundNgn" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "Driver" DROP COLUMN "totalEarningsUsdt",
ADD COLUMN     "totalEarningsNgn" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Feedback" DROP COLUMN "commentHash",
DROP COLUMN "onchainTxHash",
DROP COLUMN "revieweeWallet";

-- AlterTable
ALTER TABLE "GroupRideMatchRequest" DROP COLUMN "fareEstimateUsdt",
ADD COLUMN     "fareEstimateNgn" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "Ride" DROP COLUMN "fareEstimateUsdt",
DROP COLUMN "fareFinalUsdt",
DROP COLUMN "penaltyUsdt",
DROP COLUMN "platformFeeUsdt",
DROP COLUMN "recordingCid",
DROP COLUMN "recordingHash",
ADD COLUMN     "agreedFareNgn" DECIMAL(18,2),
ADD COLUMN     "fareEstimateNgn" DECIMAL(18,2),
ADD COLUMN     "fareFinalNgn" DECIMAL(18,2),
ADD COLUMN     "paymentMethod" "RidePaymentMethod" NOT NULL DEFAULT 'WALLET',
ADD COLUMN     "penaltyNgn" DECIMAL(18,2),
ADD COLUMN     "platformFeeNgn" DECIMAL(18,2),
ADD COLUMN     "riderOfferNgn" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "RideHold" DROP COLUMN "amountUsdt",
DROP COLUMN "settledAmountUsdt",
ADD COLUMN     "amountNgn" DECIMAL(18,2) NOT NULL,
ADD COLUMN     "driverUserId" TEXT,
ADD COLUMN     "settledAmountNgn" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "ScheduledRide" DROP COLUMN "fareEstimateUsdt",
DROP COLUMN "riderWallet",
ADD COLUMN     "fareEstimateNgn" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "amountUsdt",
DROP COLUMN "balanceAfter",
ADD COLUMN     "amountNgn" DECIMAL(18,2) NOT NULL,
ADD COLUMN     "balanceAfterNgn" DECIMAL(18,2) NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "walletAddress",
ADD COLUMN     "bvn" TEXT,
ADD COLUMN     "kycVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "pouchCustomerId" TEXT,
ADD COLUMN     "riderKycStatus" "RiderKycStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "selfieCid" TEXT;

-- AlterTable
ALTER TABLE "UserConsent" DROP COLUMN "consentTxHash";

-- AlterTable
ALTER TABLE "VirtualAccount" DROP COLUMN "korapayRef",
DROP COLUMN "walletId",
ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'NG',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'NGN',
ADD COLUMN     "pouchCustomerId" TEXT NOT NULL,
ADD COLUMN     "pouchVirtualAccountId" TEXT NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Wallet" DROP COLUMN "address",
DROP COLUMN "balanceUsdt",
DROP COLUMN "chain",
DROP COLUMN "lockedUsdt",
DROP COLUMN "stakedUsdt",
ADD COLUMN     "balanceNgn" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "lockedNgn" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WalletReservation" DROP COLUMN "amountUsdt",
ADD COLUMN     "amountNgn" DECIMAL(18,2) NOT NULL;

-- AlterTable
ALTER TABLE "WithdrawalRequest" DROP COLUMN "cryptoCurrency",
DROP COLUMN "cryptoNetwork",
DROP COLUMN "displayCurrency",
DROP COLUMN "displayExchangeRate",
DROP COLUMN "paymentId",
DROP COLUMN "payoutCurrency",
DROP COLUMN "quotedAmountNgn",
DROP COLUMN "quotedAmountUsd",
DROP COLUMN "quotedCryptoAmount",
DROP COLUMN "reservedAmountUsdt",
ADD COLUMN     "pouchPayoutId" TEXT,
ADD COLUMN     "reservedAmountNgn" DECIMAL(18,2) NOT NULL;

-- DropTable
DROP TABLE "DefiPosition";

-- DropTable
DROP TABLE "PaymentIntent";

-- DropTable
DROP TABLE "PaymentRecord";

-- DropTable
DROP TABLE "Recording";

-- DropTable
DROP TABLE "YieldHarvest";

-- DropEnum
DROP TYPE "DefiPositionStatus";

-- DropEnum
DROP TYPE "DefiProtocol";

-- DropEnum
DROP TYPE "DefiTier";

-- DropEnum
DROP TYPE "PaymentIntentStatus";

-- DropEnum
DROP TYPE "PaymentRecordStatus";

-- DropEnum
DROP TYPE "PaymentSessionType";

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "rideId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderRole" "ChatSenderRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiderKycAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RiderKycStatus" NOT NULL,
    "selfieKey" TEXT,
    "livenessScore" DOUBLE PRECISION,
    "failureReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiderKycAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatMessage_rideId_createdAt_idx" ON "ChatMessage"("rideId", "createdAt");

-- CreateIndex
CREATE INDEX "RiderKycAttempt_userId_createdAt_idx" ON "RiderKycAttempt"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_pouchCustomerId_key" ON "User"("pouchCustomerId");

-- CreateIndex
CREATE INDEX "User_pouchCustomerId_idx" ON "User"("pouchCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualAccount_userId_key" ON "VirtualAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VirtualAccount_pouchVirtualAccountId_key" ON "VirtualAccount"("pouchVirtualAccountId");

-- CreateIndex
CREATE INDEX "VirtualAccount_pouchVirtualAccountId_idx" ON "VirtualAccount"("pouchVirtualAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_pouchPayoutId_key" ON "WithdrawalRequest"("pouchPayoutId");

-- AddForeignKey
ALTER TABLE "VirtualAccount" ADD CONSTRAINT "VirtualAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_rideId_fkey" FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiderKycAttempt" ADD CONSTRAINT "RiderKycAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
