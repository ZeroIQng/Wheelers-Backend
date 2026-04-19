ALTER TYPE "TransactionType" RENAME VALUE 'NGN_DEPOSIT' TO 'FIAT_ONRAMP';

ALTER TABLE "PaymentRecord"
  RENAME COLUMN "amountNgn" TO "amountLocal";

ALTER TABLE "PaymentRecord"
  ADD COLUMN "localCurrency" TEXT NOT NULL DEFAULT 'NGN';
