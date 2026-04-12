CREATE UNIQUE INDEX "Transaction_walletId_type_direction_referenceId_key"
ON "Transaction"("walletId", "type", "direction", "referenceId");
