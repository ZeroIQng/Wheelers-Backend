-- Interstate bidding: a rider can offer below the posted price, and a driver
-- decides. Nothing is charged and no seat is held until that happens.
--
-- The enum values these columns work alongside were added in the migration
-- before this one, so they are already committed by the time this runs.

ALTER TABLE "InterstateBooking"
  ADD COLUMN "offeredNgn"    DECIMAL(18,2),
  ADD COLUMN "listPriceNgn"  DECIMAL(18,2),
  ADD COLUMN "declineReason" TEXT,
  ADD COLUMN "acceptedAt"    TIMESTAMP(3);

-- Every booking that already exists was taken at the posted price.
UPDATE "InterstateBooking" SET "offeredNgn" = "amountNgn", "listPriceNgn" = "amountNgn";
