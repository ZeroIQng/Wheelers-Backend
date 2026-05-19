CREATE TYPE "GroupRideMatchRequestStatus" AS ENUM (
    'PENDING_FACE_UPLOAD',
    'READY_FOR_MATCH',
    'MATCHING',
    'GROUPED',
    'BOOKED',
    'EXPIRED',
    'CANCELLED'
);

CREATE TYPE "GroupRideFaceVerificationStatus" AS ENUM (
    'UPLOADING',
    'STORED',
    'FAILED'
);

CREATE TABLE "GroupRideMatchRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "GroupRideMatchRequestStatus" NOT NULL DEFAULT 'PENDING_FACE_UPLOAD',
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "destLat" DOUBLE PRECISION NOT NULL,
    "destLng" DOUBLE PRECISION NOT NULL,
    "destAddress" TEXT NOT NULL,
    "stops" JSONB,
    "plannedDistanceKm" DOUBLE PRECISION,
    "plannedDurationSeconds" INTEGER,
    "fareEstimateUsdt" DECIMAL(18,6),
    "paymentMethod" "ScheduledRidePaymentMethod" NOT NULL DEFAULT 'WALLET_BALANCE',
    "readyForMatchAt" TIMESTAMP(3),
    "matchingStartedAt" TIMESTAMP(3),
    "groupedAt" TIMESTAMP(3),
    "bookedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupRideMatchRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupRideFaceVerification" (
    "id" TEXT NOT NULL,
    "matchRequestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "etag" TEXT,
    "uploadStatus" "GroupRideFaceVerificationStatus" NOT NULL DEFAULT 'UPLOADING',
    "capturedAt" TIMESTAMP(3),
    "storedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupRideFaceVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupRideFaceVerification_matchRequestId_key" ON "GroupRideFaceVerification"("matchRequestId");
CREATE UNIQUE INDEX "GroupRideFaceVerification_bucket_objectKey_key" ON "GroupRideFaceVerification"("bucket", "objectKey");

CREATE INDEX "GroupRideMatchRequest_userId_status_createdAt_idx" ON "GroupRideMatchRequest"("userId", "status", "createdAt");
CREATE INDEX "GroupRideMatchRequest_status_updatedAt_idx" ON "GroupRideMatchRequest"("status", "updatedAt");
CREATE INDEX "GroupRideFaceVerification_userId_uploadStatus_createdAt_idx" ON "GroupRideFaceVerification"("userId", "uploadStatus", "createdAt");

ALTER TABLE "GroupRideMatchRequest" ADD CONSTRAINT "GroupRideMatchRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupRideFaceVerification" ADD CONSTRAINT "GroupRideFaceVerification_matchRequestId_fkey" FOREIGN KEY ("matchRequestId") REFERENCES "GroupRideMatchRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupRideFaceVerification" ADD CONSTRAINT "GroupRideFaceVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
