import { prisma }  from '../prisma';
import type { RideStatus, CancelStage, Prisma } from '@prisma/client';

export const rideClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findById: (rideId: string) =>
    prisma.ride.findUniqueOrThrow({ where: { id: rideId } }),

  findWithDriver: (rideId: string) =>
    prisma.ride.findUniqueOrThrow({
      where:   { id: rideId },
      include: { driver: { include: { user: true } } },
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
    fareEstimateUsdt: number;
  }) =>
    prisma.ride.create({ data }),

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