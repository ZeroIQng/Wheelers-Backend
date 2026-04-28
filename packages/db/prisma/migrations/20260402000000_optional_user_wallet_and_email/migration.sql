ALTER TABLE "User"
ADD COLUMN "email" TEXT;

ALTER TABLE "User"
ALTER COLUMN "walletAddress" DROP NOT NULL;

CREATE INDEX "User_email_idx" ON "User"("email");
