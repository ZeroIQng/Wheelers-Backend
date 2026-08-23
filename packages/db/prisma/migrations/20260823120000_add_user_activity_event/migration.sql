-- CreateTable
CREATE TABLE "UserActivityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rideId" TEXT,
    "metadata" JSONB,
    "dedupKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserActivityEvent_dedupKey_key" ON "UserActivityEvent"("dedupKey");

-- CreateIndex
CREATE INDEX "UserActivityEvent_userId_createdAt_idx" ON "UserActivityEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UserActivityEvent_eventType_createdAt_idx" ON "UserActivityEvent"("eventType", "createdAt");
