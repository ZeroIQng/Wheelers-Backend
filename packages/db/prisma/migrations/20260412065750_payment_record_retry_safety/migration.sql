CREATE TYPE "PaymentRecordStatus" AS ENUM ('RECEIVED', 'CONVERTING', 'CONVERTED');

CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReference" TEXT NOT NULL,
    "userWallet" TEXT NOT NULL,
    "amountNgn" DECIMAL(18,2) NOT NULL,
    "amountUsdt" DECIMAL(18,6),
    "exchangeRate" DECIMAL(18,6),
    "status" "PaymentRecordStatus" NOT NULL DEFAULT 'RECEIVED',
    "conversionLeaseExpiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentRecord_paymentId_key" ON "PaymentRecord"("paymentId");
CREATE UNIQUE INDEX "PaymentRecord_providerReference_key" ON "PaymentRecord"("providerReference");
CREATE INDEX "PaymentRecord_userId_status_idx" ON "PaymentRecord"("userId", "status");
