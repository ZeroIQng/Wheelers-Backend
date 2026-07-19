-- CreateTable
CREATE TABLE IF NOT EXISTS "DriverKycSubmission" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "ninImageKey" TEXT,
    "licenceImageKey" TEXT,
    "selfieKey" TEXT,
    "vehicleImageKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vehicleMake" TEXT,
    "vehicleModel" TEXT,
    "vehiclePlate" TEXT,
    "vehicleYear" INTEGER,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "rejectionReason" TEXT,
    "rejectedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fieldStatuses" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverKycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DriverKycSubmission_driverId_key" ON "DriverKycSubmission"("driverId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DriverKycSubmission_status_submittedAt_idx" ON "DriverKycSubmission"("status", "submittedAt");

-- AddForeignKey
ALTER TABLE "DriverKycSubmission" ADD CONSTRAINT "DriverKycSubmission_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
