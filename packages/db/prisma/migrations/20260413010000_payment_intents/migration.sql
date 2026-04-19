CREATE TYPE "PaymentSessionType" AS ENUM ('ONRAMP', 'OFFRAMP');

CREATE TYPE "PaymentIntentStatus" AS ENUM (
    'PENDING',
    'REQUIRES_USER_ACTION',
    'PROCESSING',
    'SETTLED',
    'FAILED',
    'EXPIRED',
    'CANCELLED'
);

CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "sessionType" "PaymentSessionType" NOT NULL,
    "lifecycleStatus" "PaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "providerStatus" TEXT NOT NULL,
    "userWallet" TEXT NOT NULL,
    "amountUsd" DECIMAL(18,6) NOT NULL,
    "amountLocal" DECIMAL(18,2),
    "localCurrency" TEXT NOT NULL DEFAULT 'NGN',
    "cryptoCurrency" TEXT NOT NULL,
    "cryptoNetwork" TEXT NOT NULL,
    "cryptoAmount" DECIMAL(18,6),
    "chain" TEXT,
    "customerEmail" TEXT,
    "walletTag" TEXT,
    "settlementReference" TEXT,
    "providerPayload" JSONB,
    "metadata" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentIntent_paymentId_key" ON "PaymentIntent"("paymentId");
CREATE UNIQUE INDEX "PaymentIntent_providerReference_key" ON "PaymentIntent"("providerReference");
CREATE INDEX "PaymentIntent_userId_lifecycleStatus_idx" ON "PaymentIntent"("userId", "lifecycleStatus");
CREATE INDEX "PaymentIntent_sessionType_lifecycleStatus_idx" ON "PaymentIntent"("sessionType", "lifecycleStatus");
