import { prisma }  from '../prisma';
import type { DisputeStatus, DisputeResolution } from '@prisma/client';

export const complianceClient = {

  // ── Recordings ─────────────────────────────────────────────────────────────

  createRecording: (data: {
    id?:             string;
    rideId:          string;
    ipfsCid:         string;
    sha256Hash:      string;
    onchainTxHash?:  string;
    consentTxHash:   string;
    encryptedWith:   string;
    durationSeconds: number;
  }) =>
    prisma.recording.create({ data }),

  findRecordingByRide: (rideId: string) =>
    prisma.recording.findUnique({ where: { rideId } }),

  // ── Disputes ───────────────────────────────────────────────────────────────

  createDispute: (data: {
    id:            string;   // UUID from the DISPUTE_OPENED Kafka event
    rideId:        string;
    openedBy:      string;
    openedByRole:  string;
    againstId:     string;
    reason:        string;
  }) =>
    prisma.dispute.create({ data }),

  findDisputeById: (disputeId: string) =>
    prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } }),

  findDisputeByRide: (rideId: string) =>
    prisma.dispute.findFirst({ where: { rideId } }),

  findOpenDisputes: () =>
    prisma.dispute.findMany({
      where:   { status: { in: ['OPEN', 'REVIEWING'] } },
      orderBy: { createdAt: 'asc' },
      include: { ride: true },
    }),

  updateDisputeStatus: (disputeId: string, status: DisputeStatus) =>
    prisma.dispute.update({
      where: { id: disputeId },
      data:  { status },
    }),

  resolveDispute: (disputeId: string, data: {
    resolution:  DisputeResolution;
    resolvedBy:  string;
    notes?:      string;
    refundUsdt?: number;
    bonusUsdt?:  number;
  }) =>
    prisma.dispute.update({
      where: { id: disputeId },
      data: {
        ...data,
        status:     'RESOLVED',
        resolvedAt: new Date(),
      },
    }),

  // ── Feedback ───────────────────────────────────────────────────────────────

  createFeedback: (data: {
    id:             string;
    rideId:         string;
    reviewerId:     string;
    reviewerRole:   string;
    revieweeId:     string;
    revieweeWallet: string;
    rating:         number;
    comment?:       string;
    commentHash?:   string;
  }) =>
    prisma.feedback.create({ data }),

  updateFeedbackOnchainTx: (feedbackId: string, onchainTxHash: string) =>
    prisma.feedback.update({
      where: { id: feedbackId },
      data:  { onchainTxHash },
    }),

  updateRecordingOnchainTx: (recordingId: string, onchainTxHash: string) =>
    prisma.recording.update({
      where: { id: recordingId },
      data: { onchainTxHash },
    }),

  findFeedbackForRide: (rideId: string) =>
    prisma.feedback.findMany({ where: { rideId } }),

  // ── Notifications ──────────────────────────────────────────────────────────

  createNotification: (data: {
    userId:        string;
    title:         string;
    body:          string;
    category:      string;
    referenceId?:  string;
    referenceType?: string;
  }) =>
    prisma.notification.create({ data: data as Parameters<typeof prisma.notification.create>[0]['data'] }),

  markNotificationsRead: (userId: string, notificationIds: string[]) =>
    prisma.notification.updateMany({
      where: { userId, id: { in: notificationIds } },
      data:  { read: true },
    }),

  findUnreadNotifications: (userId: string, limit = 20) =>
    prisma.notification.findMany({
      where:   { userId, read: false },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    }),
};
