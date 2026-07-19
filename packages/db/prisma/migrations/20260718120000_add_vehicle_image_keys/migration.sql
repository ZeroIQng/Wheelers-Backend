-- AlterTable
ALTER TABLE "DriverKycSubmission" ADD COLUMN "vehicleImageKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
