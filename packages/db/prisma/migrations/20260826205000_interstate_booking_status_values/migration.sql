-- The two new booking states, on their own.
--
-- Split from the migration that adds the bidding columns on purpose: Postgres
-- will not let a new enum value be *used* in the same transaction that adds it,
-- and Prisma wraps each migration file in one transaction. Keeping the ADD
-- VALUE statements in their own file means they are committed before any later
-- migration can reference them.

ALTER TYPE "InterstateBookingStatus" ADD VALUE IF NOT EXISTS 'PENDING_OFFER' BEFORE 'CONFIRMED';
ALTER TYPE "InterstateBookingStatus" ADD VALUE IF NOT EXISTS 'OFFER_DECLINED' BEFORE 'CONFIRMED';
