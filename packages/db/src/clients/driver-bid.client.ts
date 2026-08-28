import { prisma } from '../prisma';
import type { DriverBidStatus } from '@prisma/client';

/**
 * Durable record of driver bids. ride-service keeps the live auction in
 * memory and forgets it the moment a ride is matched, so this is the only
 * place a driver can look back at what they offered and how it went.
 *
 * One row per (ride, driver): a re-bid on the same request — after the rider
 * counters, say — replaces the amount rather than adding a second entry, so
 * the history reads "you bid ₦6,000 on this trip", not three near-duplicates.
 */
export const driverBidClient = {
  record: (input: {
    rideId: string;
    driverId: string;
    driverUserId: string;
    riderId: string;
    amountNgn: number;
    etaSeconds: number;
    distanceKm?: number;
  }) =>
    prisma.driverBid.upsert({
      where: { rideId_driverId: { rideId: input.rideId, driverId: input.driverId } },
      create: {
        rideId: input.rideId,
        driverId: input.driverId,
        driverUserId: input.driverUserId,
        riderId: input.riderId,
        amountNgn: input.amountNgn,
        etaSeconds: input.etaSeconds,
        distanceKm: input.distanceKm ?? null,
      },
      update: {
        amountNgn: input.amountNgn,
        etaSeconds: input.etaSeconds,
        distanceKm: input.distanceKm ?? null,
        status: 'PENDING',
        resolvedAt: null,
      },
    }),

  /** The rider picked this driver: their bid won, every other open bid lost. */
  markAccepted: (rideId: string, driverId: string) => {
    const now = new Date();
    return prisma.$transaction([
      prisma.driverBid.updateMany({
        where: { rideId, driverId },
        data: { status: 'ACCEPTED', resolvedAt: now },
      }),
      prisma.driverBid.updateMany({
        where: { rideId, driverId: { not: driverId }, status: 'PENDING' },
        data: { status: 'LOST', resolvedAt: now },
      }),
    ]);
  },

  /** The auction ended with nobody chosen — timeout or cancellation. */
  resolvePending: (rideId: string, status: Extract<DriverBidStatus, 'EXPIRED' | 'CANCELLED'>) =>
    prisma.driverBid.updateMany({
      where: { rideId, status: 'PENDING' },
      data: { status, resolvedAt: new Date() },
    }),

  /** The driver took their own bid back before the rider answered. */
  markWithdrawn: (rideId: string, driverId: string) =>
    prisma.driverBid.updateMany({
      where: { rideId, driverId, status: 'PENDING' },
      data: { status: 'WITHDRAWN', resolvedAt: new Date() },
    }),

  findForDriver: (driverId: string, limit = 20, cursor?: string) =>
    prisma.driverBid.findMany({
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        ride: {
          select: {
            status: true,
            pickupAddress: true,
            destAddress: true,
            fareEstimateNgn: true,
            riderOfferNgn: true,
            agreedFareNgn: true,
            distanceKm: true,
            matchedAt: true,
            completedAt: true,
            cancelledAt: true,
          },
        },
      },
    }),

  findByRide: (rideId: string) =>
    prisma.driverBid.findMany({
      where: { rideId },
      orderBy: { createdAt: 'asc' },
    }),
};
