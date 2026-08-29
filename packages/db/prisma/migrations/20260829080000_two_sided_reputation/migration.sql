-- Two-sided reputation. Ratings existed only as static defaults: nothing
-- consumed feedback into aggregates, and riders had no rating at all —
-- drivers were being asked to bid for anonymous coordinates.
ALTER TABLE "User"
  ADD COLUMN "riderRating"      DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  ADD COLUMN "riderRatingCount" INTEGER          NOT NULL DEFAULT 0;

ALTER TABLE "Driver"
  ADD COLUMN "ratingCount" INTEGER NOT NULL DEFAULT 0;
