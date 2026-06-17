import { prisma }  from '../prisma';
import type { DisputeStatus, DisputeResolution } from '@prisma/client';

export const complianceClient = {

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
    refundNgn?:  number;
    bonusNgn?:   number;
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
    rating:         number;
    comment?:       string;
  }) =>
    prisma.feedback.create({ data }),

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

  markAllNotificationsRead: (userId: string) =>
    prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    }),

  findUnreadNotifications: (userId: string, limit = 20) =>
    prisma.notification.findMany({
      where:   { userId, read: false },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    }),

  listNotifications: (userId: string, limit = 50) =>
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
};
