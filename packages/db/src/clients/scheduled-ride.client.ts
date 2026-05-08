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
    .map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return null;
      }

      const record = item as Record<string, unknown>;
      return {
        lat: typeof record.lat === 'number' ? record.lat : 0,
        lng: typeof record.lng === 'number' ? record.lng : 0,
        address: typeof record.address === 'string' ? record.address : '',
      };
    })
    .filter((item): item is ScheduledStopInput => item !== null)
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

     /**
   * Atomically:
   *   1. Transitions ride DISPATCHING → DISPATCHED and records requestedRideId.
   *   2. Inserts an OutboxEvent with the RIDE_REQUESTED payload.
   *
   * If Kafka is down, the ride is still marked DISPATCHED in the DB.
   * The outbox publisher will deliver the event when Kafka recovers.
   *
   * Safe to call only after claimForDispatch has returned a non-null result.
   */
  markDispatchedWithOutbox: async (params: {
    id: string;
    rideId: string;
    outbox: { topic: string; key: string; payload: unknown };
  }) => {
    const [ride] = await prisma.$transaction([
      prisma.scheduledRide.update({
        where: { id: params.id },
        data: {
          status: ScheduledRideStatus.DISPATCHED,
          requestedRideId: params.rideId,
          dispatchedAt: new Date(),
        },
      }),
      prisma.outboxEvent.create({
        data: {
          topic: params.outbox.topic,
          key: params.outbox.key,
          payload: params.outbox.payload as Prisma.InputJsonValue,
        },
      }),
    ]);
    return ride;
  },

  /**
   * Returns scheduled rides that are past their dispatch window but still
   * have status = SCHEDULED (i.e. the BullMQ job was lost or never created).
   *
   * `dispatchBefore` should be `now + leadTimeMs`.
   */
  findDueForDispatch: (dispatchBefore: Date, limit = 10) =>
    prisma.scheduledRide.findMany({
      where: {
        status: ScheduledRideStatus.SCHEDULED,
        scheduledFor: { lte: dispatchBefore },
      },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
    }),

  /**
   * Find rides stuck in DISPATCHING for more than `stuckAfterMs` ms.
   * These are rides where claimForDispatch ran but markDispatchedWithOutbox
   * never completed (worker crash). Reset them to SCHEDULED for re-dispatch.
   */
  releaseStuckDispatching: (stuckAfterMs = 60_000) =>
    prisma.scheduledRide.updateMany({
      where: {
        status: ScheduledRideStatus.DISPATCHING,
        // Prisma doesn't have updatedAt by default — use scheduledFor as proxy,
        // or add an `updatedAt` field. If updatedAt exists:
        updatedAt: { lt: new Date(Date.now() - stuckAfterMs) },
      },
      data: { status: ScheduledRideStatus.SCHEDULED },
    }),

  parseStops,
};
