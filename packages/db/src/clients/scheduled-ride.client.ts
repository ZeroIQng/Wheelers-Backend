import { Prisma, ScheduledRidePaymentMethod, ScheduledRideStatus } from '@prisma/client';
import { prisma } from '../prisma';

type ScheduledStopInput = {
  lat: number;
  lng: number;
  address: string;
};

function serializeStops(stops: ScheduledStopInput[]): Prisma.InputJsonValue {
  return stops as unknown as Prisma.InputJsonValue;
}

function parseStops(value: Prisma.JsonValue | null | undefined): ScheduledStopInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      lat: typeof item.lat === 'number' ? item.lat : 0,
      lng: typeof item.lng === 'number' ? item.lng : 0,
      address: typeof item.address === 'string' ? item.address : '',
    }))
    .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng) && item.address.length > 0);
}

export const scheduledRideClient = {
  create: (data: {
    riderId: string;
    riderWallet: string;
    scheduledFor: Date;
    paymentMethod?: ScheduledRidePaymentMethod;
    pickupLat: number;
    pickupLng: number;
    pickupAddress: string;
    destLat: number;
    destLng: number;
    destAddress: string;
    stops?: ScheduledStopInput[];
    plannedDistanceKm?: number;
    plannedDurationSeconds?: number;
    fareEstimateUsdt?: number;
  }) =>
    prisma.scheduledRide.create({
      data: {
        riderId: data.riderId,
        riderWallet: data.riderWallet,
        scheduledFor: data.scheduledFor,
        paymentMethod: data.paymentMethod ?? ScheduledRidePaymentMethod.WALLET_BALANCE,
        pickupLat: data.pickupLat,
        pickupLng: data.pickupLng,
        pickupAddress: data.pickupAddress,
        destLat: data.destLat,
        destLng: data.destLng,
        destAddress: data.destAddress,
        stops: serializeStops(data.stops ?? []),
        plannedDistanceKm: data.plannedDistanceKm,
        plannedDurationSeconds: data.plannedDurationSeconds,
        fareEstimateUsdt: data.fareEstimateUsdt,
      },
    }),

  findByRider: (riderId: string, limit = 20, cursor?: string) =>
    prisma.scheduledRide.findMany({
      where: {
        riderId,
        status: { in: [ScheduledRideStatus.SCHEDULED, ScheduledRideStatus.DISPATCHING] },
      },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  cancel: (id: string, riderId: string, reason?: string) =>
    prisma.scheduledRide.updateMany({
      where: {
        id,
        riderId,
        status: { in: [ScheduledRideStatus.SCHEDULED, ScheduledRideStatus.DISPATCHING] },
      },
      data: {
        status: ScheduledRideStatus.CANCELLED,
        cancellationReason: reason,
        cancelledAt: new Date(),
      },
    }),

  findDueForDispatch: (dispatchBefore: Date, limit = 10) =>
    prisma.scheduledRide.findMany({
      where: {
        status: ScheduledRideStatus.SCHEDULED,
        scheduledFor: { lte: dispatchBefore },
      },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
    }),

  claimForDispatch: async (id: string) => {
    const result = await prisma.scheduledRide.updateMany({
      where: {
        id,
        status: ScheduledRideStatus.SCHEDULED,
      },
      data: {
        status: ScheduledRideStatus.DISPATCHING,
      },
    });

    if (result.count === 0) {
      return null;
    }

    return prisma.scheduledRide.findUniqueOrThrow({ where: { id } });
  },

  markDispatched: (id: string, rideId: string) =>
    prisma.scheduledRide.update({
      where: { id },
      data: {
        status: ScheduledRideStatus.DISPATCHED,
        requestedRideId: rideId,
        dispatchedAt: new Date(),
      },
    }),

  releaseClaim: (id: string) =>
    prisma.scheduledRide.updateMany({
      where: {
        id,
        status: ScheduledRideStatus.DISPATCHING,
      },
      data: {
        status: ScheduledRideStatus.SCHEDULED,
      },
    }),

  expireMissed: (before: Date) =>
    prisma.scheduledRide.updateMany({
      where: {
        status: ScheduledRideStatus.SCHEDULED,
        scheduledFor: { lt: before },
      },
      data: {
        status: ScheduledRideStatus.EXPIRED,
      },
    }),

  parseStops,
};
