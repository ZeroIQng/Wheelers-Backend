import { prisma }   from '../prisma';
import type { DriverStatus, KycStatus } from '@prisma/client';

export const driverClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findById: (driverId: string) =>
    prisma.driver.findUniqueOrThrow({
      where:   { id: driverId },
      include: { user: true },
    }),

  findByUserId: (userId: string) =>
    prisma.driver.findUnique({
      where:   { userId },
      include: { user: true },
    }),

  // Haversine formula inside raw SQL to find online drivers within radiusKm.
  // Returns up to limit drivers, ordered by distance ascending.
  // ride-service calls this during matching after a RIDE_REQUESTED event.
  findNearby: (lat: number, lng: number, radiusKm: number, limit = 10) =>
    prisma.$queryRaw<Array<{
      id:           string;
      userId:       string;
      walletAddress: string;
      lat:          number;
      lng:          number;
      rating:       number;
      vehiclePlate: string | null;
      vehicleModel: string | null;
      distanceKm:   number;
    }>>`
      SELECT
        d.id,
        d."userId",
        u."walletAddress",
        d.lat,
        d.lng,
        d.rating,
        d."vehiclePlate",
        d."vehicleModel",
        ROUND(CAST(
          6371 * acos(
            cos(radians(${lat})) * cos(radians(d.lat)) *
            cos(radians(d.lng) - radians(${lng})) +
            sin(radians(${lat})) * sin(radians(d.lat))
          )
        AS numeric), 3) AS "distanceKm"
      FROM "Driver" d
      JOIN "User" u ON u.id = d."userId"
      WHERE
        d.status    = 'ONLINE'
        AND d."kycStatus" = 'APPROVED'
        AND d.lat   IS NOT NULL
        AND d.lng   IS NOT NULL
        AND (
          6371 * acos(
            cos(radians(${lat})) * cos(radians(d.lat)) *
            cos(radians(d.lng) - radians(${lng})) +
            sin(radians(${lat})) * sin(radians(d.lat))
          )
        ) <= ${radiusKm}
      ORDER BY "distanceKm" ASC
      LIMIT ${limit}
    `,

  // ── Writes ─────────────────────────────────────────────────────────────────

  create: (userId: string) =>
    prisma.driver.create({
      data: { userId },
    }),

  updateStatus: (driverId: string, status: DriverStatus) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { status, lastSeenAt: new Date() },
    }),

  markOnline: (driverId: string, lat: number, lng: number) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { status: 'ONLINE', lat, lng, lastSeenAt: new Date() },
    }),

  markOffline: (driverId: string) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { status: 'OFFLINE', lastSeenAt: new Date() },
    }),

  // Called every time driver goes online or sends a GPS ping during availability.
  // Live ride GPS is handled separately — this is just "driver is at this location".
  updateLocation: (driverId: string, lat: number, lng: number) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { lat, lng, lastSeenAt: new Date() },
    }),

  updateKycStatus: (driverId: string, kycStatus: KycStatus) =>
    prisma.driver.update({
      where: { id: driverId },
      data:  { kycStatus },
    }),

  updateVehicle: (driverId: string, data: {
    vehicleMake?:  string;
    vehicleModel?: string;
    vehiclePlate?: string;
    vehicleYear?:  number;
    licenceCid?:   string;
    insuranceCid?: string;
    selfieHash?:   string;
  }) =>
    prisma.driver.update({
      where: { id: driverId },
      data,
    }),

  // Called after RIDE_COMPLETED — increments counters atomically.
  recordCompletedRide: (driverId: string, earningsUsdt: number) =>
    prisma.driver.update({
      where: { id: driverId },
      data: {
        totalRides:         { increment: 1 },
        totalEarningsUsdt:  { increment: earningsUsdt },
      },
    }),

  updateRating: async (driverId: string) => {
    // Recalculate average from all feedback for this driver.
    // Called by compliance-worker after each FEEDBACK_LOGGED event.
    const result = await prisma.feedback.aggregate({
      where:   { revieweeId: driverId },
      _avg:    { rating: true },
      _count:  { rating: true },
    });

    if (result._avg.rating === null) return;

    return prisma.driver.update({
      where: { id: driverId },
      data:  { rating: result._avg.rating },
    });
  },

  // ── KYC reviews ────────────────────────────────────────────────────────────

  createKycReview: (data: {
    driverId:   string;
    outcome:    KycStatus;
    reviewedBy: string;
    notes?:     string;
  }) =>
    prisma.driverKycReview.create({
      data: {
        ...data,
        reviewedAt: new Date(),
      },
    }),

  findKycHistory: (driverId: string) =>
    prisma.driverKycReview.findMany({
      where:   { driverId },
      orderBy: { submittedAt: 'desc' },
    }),
};
