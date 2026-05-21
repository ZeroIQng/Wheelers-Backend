CREATE TABLE "NotificationDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expoPushToken" TEXT NOT NULL,
    "platform" TEXT,
    "deviceName" TEXT,
    "appOwnership" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRegisteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDeliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDevice_expoPushToken_key" ON "NotificationDevice"("expoPushToken");
CREATE INDEX "NotificationDevice_userId_enabled_updatedAt_idx" ON "NotificationDevice"("userId", "enabled", "updatedAt");

ALTER TABLE "NotificationDevice" ADD CONSTRAINT "NotificationDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
