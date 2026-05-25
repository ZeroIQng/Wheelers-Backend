import type {
  GroupRideGenderPreference,
  GroupRideMatchRequestStatus,
  ScheduledRidePaymentMethod,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export const groupRideClient = {
  createMatchRequest: (data: {
    id?: string;
    userId: string;
    pickupLat: number;
    pickupLng: number;
    pickupAddress: string;
    destLat: number;
    destLng: number;
    destAddress: string;
    genderPreference?: GroupRideGenderPreference;
    stops?: unknown[];
    plannedDistanceKm?: number;
    plannedDurationSeconds?: number;
    fareEstimateUsdt?: number;
    paymentMethod?: ScheduledRidePaymentMethod;
  }) =>
    prisma.groupRideMatchRequest.create({
      data: {
        id: data.id,
        userId: data.userId,
        pickupLat: data.pickupLat,
        pickupLng: data.pickupLng,
        pickupAddress: data.pickupAddress,
        destLat: data.destLat,
        destLng: data.destLng,
        destAddress: data.destAddress,
        genderPreference: data.genderPreference,
        stops: data.stops
          ? (data.stops as Prisma.InputJsonValue)
          : undefined,
        plannedDistanceKm: data.plannedDistanceKm,
        plannedDurationSeconds: data.plannedDurationSeconds,
        fareEstimateUsdt: data.fareEstimateUsdt,
        paymentMethod: data.paymentMethod,
      },
      include: {
        faceVerification: true,
        user: true,
      },
    }),

  findMatchRequestByIdForUser: (id: string, userId: string) =>
    prisma.groupRideMatchRequest.findFirst({
      where: { id, userId },
      include: {
        faceVerification: true,
        user: true,
      },
    }),

  findMatchRequestById: (id: string) =>
    prisma.groupRideMatchRequest.findUnique({
      where: { id },
      include: {
        faceVerification: true,
        user: true,
      },
    }),

  listMatchRequestsByUser: (userId: string, limit = 20) =>
    prisma.groupRideMatchRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        faceVerification: true,
        user: true,
      },
    }),

  findMatchRequestsByIds: (ids: string[]) =>
    prisma.groupRideMatchRequest.findMany({
      where: {
        id: {
          in: ids,
        },
      },
      include: {
        faceVerification: true,
        user: true,
      },
    }),

  upsertFaceVerificationUpload: (data: {
    matchRequestId: string;
    userId: string;
    bucket: string;
    objectKey: string;
    mimeType: string;
    capturedAt?: Date;
  }) =>
    prisma.groupRideFaceVerification.upsert({
      where: { matchRequestId: data.matchRequestId },
      create: {
        matchRequestId: data.matchRequestId,
        userId: data.userId,
        bucket: data.bucket,
        objectKey: data.objectKey,
        mimeType: data.mimeType,
        capturedAt: data.capturedAt,
        uploadStatus: 'UPLOADING',
      },
      update: {
        userId: data.userId,
        bucket: data.bucket,
        objectKey: data.objectKey,
        mimeType: data.mimeType,
        capturedAt: data.capturedAt,
        sizeBytes: null,
        etag: null,
        uploadStatus: 'UPLOADING',
        storedAt: null,
        failedAt: null,
        failureReason: null,
      },
    }),

  completeFaceVerificationAndMarkReady: (data: {
    matchRequestId: string;
    sizeBytes?: number;
    etag?: string;
    capturedAt?: Date;
  }) =>
    prisma.$transaction(async (tx) => {
      const storedAt = new Date();

      const verification = await tx.groupRideFaceVerification.update({
        where: { matchRequestId: data.matchRequestId },
        data: {
          sizeBytes: data.sizeBytes,
          etag: data.etag,
          capturedAt: data.capturedAt,
          uploadStatus: 'STORED',
          storedAt,
          failedAt: null,
          failureReason: null,
        },
      });

      const request = await tx.groupRideMatchRequest.update({
        where: { id: data.matchRequestId },
        data: {
          status: 'READY_FOR_MATCH',
          readyForMatchAt: storedAt,
        },
        include: {
          faceVerification: true,
          user: true,
        },
      });

      return {
        request,
        verification,
      };
    }),

  markFaceVerificationFailed: (data: {
    matchRequestId: string;
    reason: string;
  }) =>
    prisma.groupRideFaceVerification.update({
      where: { matchRequestId: data.matchRequestId },
      data: {
        uploadStatus: 'FAILED',
        failedAt: new Date(),
        failureReason: data.reason,
      },
    }),

  updateMatchRequestStatus: (
    id: string,
    status: GroupRideMatchRequestStatus,
  ) =>
    prisma.groupRideMatchRequest.update({
      where: { id },
      data: buildStatusUpdate(status),
      include: {
        faceVerification: true,
        user: true,
      },
    }),

  assignRequestsToGroup: (data: {
    groupId: string;
    rideIds: string[];
    status: GroupRideMatchRequestStatus;
  }) => {
    const matchedRideIds = data.rideIds as Prisma.InputJsonValue;
    return prisma.$transaction(
      data.rideIds.map((rideId) =>
        prisma.groupRideMatchRequest.update({
          where: { id: rideId },
          data: {
            ...buildStatusUpdate(data.status),
            groupId: data.groupId,
            matchedRideIds,
          },
          include: {
            faceVerification: true,
            user: true,
          },
        }),
      ),
    );
  },

  cancelMatchRequestForUser: (
    id: string,
    userId: string,
    reason?: string,
  ) =>
    prisma.groupRideMatchRequest.updateMany({
      where: {
        id,
        userId,
        status: {
          in: ['PENDING_FACE_UPLOAD', 'READY_FOR_MATCH', 'MATCHING'],
        },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason,
      },
    }),

  findReadyRequests: () =>
    prisma.groupRideMatchRequest.findMany({
      where: {
        status: {
          in: ['READY_FOR_MATCH', 'MATCHING'],
        },
      },
      include: {
        faceVerification: true,
      },
      orderBy: {
        readyForMatchAt: 'asc',
      },
    }),
};

function buildStatusUpdate(status: GroupRideMatchRequestStatus) {
  const now = new Date();
  const data: {
    status: GroupRideMatchRequestStatus;
    matchingStartedAt?: Date;
    groupedAt?: Date;
    bookedAt?: Date;
    expiredAt?: Date;
    cancelledAt?: Date;
  } = { status };

  if (status === 'MATCHING') {
    data.matchingStartedAt = now;
  }

  if (status === 'GROUPED') {
    data.groupedAt = now;
  }

  if (status === 'BOOKED') {
    data.bookedAt = now;
  }

  if (status === 'EXPIRED') {
    data.expiredAt = now;
  }

  if (status === 'CANCELLED') {
    data.cancelledAt = now;
  }

  return data;
}
