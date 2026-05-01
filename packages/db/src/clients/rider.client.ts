import { prisma } from '../prisma';
import type { CancelStage, RideStatus, RideStopStatus, RideStopType } from '@prisma/client';

type RouteStopInput = {
  lat: number;
  lng: number;
  address: string;
};

type CompletedRouteStopInput = RouteStopInput & {
  type: RideStopType;
  status: RideStopStatus;
  completedAt: Date | null;
};

type RouteDestinationInput = RouteStopInput;

function buildRouteStops(params: {
  rideId: string;
  completedStops?: CompletedRouteStopInput[];
  stops?: RouteStopInput[];
  destination: RouteDestinationInput;
}) {
  const completedStops = params.completedStops ?? [];
  const requestedStops = params.stops ?? [];
  const routeStops = [
    ...completedStops.map((stop, index) => ({
      rideId: params.rideId,
      stopOrder: index,
      type: stop.type,
      status: stop.status,
      lat: stop.lat,
      lng: stop.lng,
      address: stop.address,
      completedAt: stop.completedAt,
    })),
    ...requestedStops.map((stop, index) => ({
      rideId: params.rideId,
      stopOrder: completedStops.length + index,
      type: 'INTERMEDIATE' as const,
      status: 'PENDING' as const,
      lat: stop.lat,
      lng: stop.lng,
      address: stop.address,
      completedAt: null,
    })),
    {
      rideId: params.rideId,
      stopOrder: completedStops.length + requestedStops.length,
      type: 'FINAL' as const,
      status: 'PENDING' as const,
      lat: params.destination.lat,
      lng: params.destination.lng,
      address: params.destination.address,
      completedAt: null,
    },
  ];

  return routeStops;
}

export const rideClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findById: (rideId: string) =>
    prisma.ride.findUniqueOrThrow({
      where: { id: rideId },
      include: {
        routeStops: {
          orderBy: { stopOrder: 'asc' },
        },
      },
    }),

  findWithDriver: (rideId: string) =>
    prisma.ride.findUniqueOrThrow({
      where:   { id: rideId },
      include: {
        driver: { include: { user: true } },
        routeStops: {
          orderBy: { stopOrder: 'asc' },
        },
      },
    }),

  findActiveByRider: (riderId: string) =>
    prisma.ride.findFirst({
      where: {
        riderId,
        status: {
          in: ['REQUESTED', 'MATCHING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'],
        },
      },
    }),

  findActiveByDriver: (driverId: string) =>
    prisma.ride.findFirst({
      where: {
        driverId,
        status: { in: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] },
      },
    }),

  findRiderHistory: (riderId: string, limit = 20, cursor?: string) =>
    prisma.ride.findMany({
      where:   { riderId, status: { in: ['COMPLETED', 'CANCELLED'] } },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  findDriverHistory: (driverId: string, limit = 20, cursor?: string) =>
    prisma.ride.findMany({
      where:   { driverId, status: { in: ['COMPLETED', 'CANCELLED'] } },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  // All rides currently in a stale-check-eligible state.
  // GPS monitor cron calls this to know which rides to check.
  findAllInProgress: () =>
    prisma.ride.findMany({
      where: { status: 'IN_PROGRESS' },
      select: {
        id:       true,
        driverId: true,
        riderId:  true,
        startedAt: true,
      },
    }),

  // ── Writes ─────────────────────────────────────────────────────────────────

  create: (data: {
    id:               string;     // UUID from the RIDE_REQUESTED Kafka event
    riderId:          string;
    pickupLat:        number;
    pickupLng:        number;
    pickupAddress:    string;
    destLat:          number;
    destLng:          number;
    destAddress:      string;
    stops?:           RouteStopInput[];
    fareEstimateUsdt: number;
    status?:          RideStatus;
  }) =>
    prisma.$transaction(async (tx) => {
      const { stops, ...rideData } = data;
      const ride = await tx.ride.create({ data: rideData });
      await tx.rideStop.createMany({
        data: buildRouteStops({
          rideId: data.id,
          stops,
          destination: {
            lat: data.destLat,
            lng: data.destLng,
            address: data.destAddress,
          },
        }),
      });
      return ride;
    }),

  markMatching: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data:  { status: 'MATCHING' },
    }),

  // Assign driver once matched — also sets matchedAt timestamp.
  assignDriver: (rideId: string, driverId: string, etaSeconds: number) =>
    prisma.ride.update({
      where: { id: rideId },
      data: {
        driverId,
        status:    'DRIVER_ASSIGNED',
        matchedAt: new Date(),
      },
    }),

  markDriverEnRoute: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data:  { status: 'DRIVER_EN_ROUTE' },
    }),

  markArrived: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data:  { status: 'ARRIVED', arrivedAt: new Date() },
    }),

  start: (rideId: string, recordingId?: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data: {
        status:      'IN_PROGRESS',
        startedAt:   new Date(),
        recordingId: recordingId ?? null,
      },
    }),

  complete: (rideId: string, data: {
    fareFinalUsdt:   number;
    platformFeeUsdt: number;
    distanceKm:      number;
    durationSeconds: number;
    recordingCid?:   string;
    recordingHash?:  string;
  }) =>
    prisma.ride.update({
      where: { id: rideId },
      data: {
        ...data,
        status:      'COMPLETED',
        completedAt: new Date(),
      },
    }),

  cancel: (rideId: string, data: {
    cancelStage:  CancelStage;
    cancelReason?: string;
    penaltyUsdt:  number;
  }) =>
    prisma.ride.update({
      where: { id: rideId },
      data: {
        ...data,
        status:      'CANCELLED',
        cancelledAt: new Date(),
      },
    }),

  markDisputed: (rideId: string) =>
    prisma.ride.update({
      where: { id: rideId },
      data:  { status: 'DISPUTED' },
    }),

  findRouteStops: (rideId: string) =>
    prisma.rideStop.findMany({
      where: { rideId },
      orderBy: { stopOrder: 'asc' },
    }),

  syncRouteStops: (rideId: string, data: {
    destination: RouteDestinationInput;
    stops?: RouteStopInput[];
    fareEstimateUsdt?: number;
  }) =>
    prisma.$transaction(async (tx) => {
      const existingCompletedStops = await tx.rideStop.findMany({
        where: {
          rideId,
          status: 'COMPLETED',
        },
        orderBy: { stopOrder: 'asc' },
      });

      await tx.ride.update({
        where: { id: rideId },
        data: {
          destLat: data.destination.lat,
          destLng: data.destination.lng,
          destAddress: data.destination.address,
          ...(data.fareEstimateUsdt !== undefined ? { fareEstimateUsdt: data.fareEstimateUsdt } : {}),
        },
      });

      await tx.rideStop.deleteMany({ where: { rideId } });
      await tx.rideStop.createMany({
        data: buildRouteStops({
          rideId,
          completedStops: existingCompletedStops.map((stop) => ({
            lat: stop.lat,
            lng: stop.lng,
            address: stop.address,
            type: stop.type,
            status: stop.status,
            completedAt: stop.completedAt,
          })),
          stops: data.stops,
          destination: data.destination,
        }),
      });

      return tx.rideStop.findMany({
        where: { rideId },
        orderBy: { stopOrder: 'asc' },
      });
    }),

  completeNextStop: (rideId: string) =>
    prisma.$transaction(async (tx) => {
      const nextPendingStop = await tx.rideStop.findFirst({
        where: {
          rideId,
          type: 'INTERMEDIATE',
          status: 'PENDING',
        },
        orderBy: { stopOrder: 'asc' },
      });

      if (!nextPendingStop) {
        return null;
      }

      const completedStop = await tx.rideStop.update({
        where: { id: nextPendingStop.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
        },
      });

      const routeStops = await tx.rideStop.findMany({
        where: { rideId },
        orderBy: { stopOrder: 'asc' },
      });

      return {
        completedStop,
        routeStops,
      };
    }),

  completeFinalStop: (rideId: string, completedAt = new Date()) =>
    prisma.$transaction(async (tx) => {
      const finalStop = await tx.rideStop.findFirst({
        where: {
          rideId,
          type: 'FINAL',
          status: 'PENDING',
        },
        orderBy: { stopOrder: 'asc' },
      });

      if (!finalStop) {
        return tx.rideStop.findMany({
          where: { rideId },
          orderBy: { stopOrder: 'asc' },
        });
      }

      await tx.rideStop.update({
        where: { id: finalStop.id },
        data: {
          status: 'COMPLETED',
          completedAt,
        },
      });

      return tx.rideStop.findMany({
        where: { rideId },
        orderBy: { stopOrder: 'asc' },
      });
    }),

  // ── GPS logs ───────────────────────────────────────────────────────────────

  // Writes a GPS snapshot for dispute evidence.
  // Not every ping — ride-service samples every 30s.
  logGpsSnapshot: (data: {
    rideId:    string;
    lat:       number;
    lng:       number;
    speedKmh?: number;
    timestamp: Date;
  }) =>
    prisma.gpsLog.create({ data }),

  findGpsLogs: (rideId: string) =>
    prisma.gpsLog.findMany({
      where:   { rideId },
      orderBy: { timestamp: 'asc' },
    }),
};
