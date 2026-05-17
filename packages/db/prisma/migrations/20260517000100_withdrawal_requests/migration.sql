CREATE TYPE "WalletReservationKind" AS ENUM ('WITHDRAWAL');
CREATE TYPE "WalletReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED');
CREATE TYPE "WithdrawalRequestStatus" AS ENUM ('PENDING', 'FUNDS_RESERVED', 'OFFRAMP_CREATED', 'PROCESSING', 'SETTLED', 'FAILED', 'EXPIRED', 'CANCELLED');

CREATE TABLE "WalletReservation" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "WalletReservationKind" NOT NULL,
    "status" "WalletReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "amountUsdt" DECIMAL(18,6) NOT NULL,
    "referenceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "WalletReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WithdrawalRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "paymentId" TEXT,
    "providerReference" TEXT,
    "status" "WithdrawalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAmountNgn" DECIMAL(18,2) NOT NULL,
    "quotedAmountNgn" DECIMAL(18,2),
    "reservedAmountUsdt" DECIMAL(18,6) NOT NULL,
    "quotedAmountUsd" DECIMAL(18,6),
    "quotedCryptoAmount" DECIMAL(18,6),
    "displayCurrency" TEXT NOT NULL DEFAULT 'NGN',
    "displayExchangeRate" DECIMAL(18,6) NOT NULL,
    "payoutCurrency" TEXT NOT NULL DEFAULT 'NGN',
    "cryptoCurrency" TEXT NOT NULL,
    "cryptoNetwork" TEXT NOT NULL,
    "bankAccountNumber" TEXT NOT NULL,
    "bankAccountName" TEXT NOT NULL,
    "bankNetworkId" TEXT NOT NULL,
    "failureReason" TEXT,
    "providerPayload" JSONB,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WalletReservation_referenceId_key" ON "WalletReservation"("referenceId");
CREATE INDEX "WalletReservation_walletId_status_idx" ON "WalletReservation"("walletId", "status");
CREATE INDEX "WalletReservation_userId_status_idx" ON "WalletReservation"("userId", "status");

CREATE UNIQUE INDEX "WithdrawalRequest_reservationId_key" ON "WithdrawalRequest"("reservationId");
CREATE UNIQUE INDEX "WithdrawalRequest_paymentId_key" ON "WithdrawalRequest"("paymentId");
CREATE UNIQUE INDEX "WithdrawalRequest_providerReference_key" ON "WithdrawalRequest"("providerReference");
CREATE INDEX "WithdrawalRequest_userId_status_createdAt_idx" ON "WithdrawalRequest"("userId", "status", "createdAt");
CREATE INDEX "WithdrawalRequest_walletId_status_createdAt_idx" ON "WithdrawalRequest"("walletId", "status", "createdAt");

ALTER TABLE "WalletReservation" ADD CONSTRAINT "WalletReservation_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletReservation" ADD CONSTRAINT "WalletReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "WithdrawalRequest_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "WalletReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
