import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Emergency alerts — the button a rider or driver presses when a trip has gone
 * wrong.
 *
 * Three rules shape everything here:
 *
 *  • **Raising one never fails on a technicality.** A missing ride id, an
 *    unknown counterpart, a location the phone could not read — none of those
 *    stop the alert being written. The worst outcome for this table is a row
 *    that should have existed and doesn't.
 *  • **Only an operator closes one.** The app can cancel an alert it raised by
 *    mistake, but it cannot mark one resolved. Resolution is an admin act with
 *    a name attached to it.
 *  • **Location is a snapshot, not a feed.** Where the person was when they
 *    pressed the button is the fact that matters.
 */

export type SafetyAlertRole = 'RIDER' | 'DRIVER';
export type SafetyAlertKind =
  | 'SOS'
  | 'UNSAFE_DRIVING'
  | 'ROUTE_DEVIATION'
  | 'ACCIDENT'
  | 'MEDICAL';
export type SafetyAlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'CANCELLED';

/** Statuses that still need somebody to do something about them. */
export const LIVE_ALERT_STATUSES: SafetyAlertStatus[] = ['OPEN', 'ACKNOWLEDGED'];

const alertWithPeople = {
  user: {
    select: {
      id: true,
      name: true,
      username: true,
      phone: true,
      email: true,
      photoUrl: true,
      role: true,
    },
  },
} satisfies Prisma.SafetyAlertInclude;

export type SafetyAlertWithPeople = Prisma.SafetyAlertGetPayload<{
  include: typeof alertWithPeople;
}>;

export const safetyAlertClient = {
  /**
   * Record an emergency. Everything except the user and their role is optional
   * on purpose — see the note above about never failing on a technicality.
   */
  raise: (params: {
    userId: string;
    raisedByRole: SafetyAlertRole;
    kind?: SafetyAlertKind;
    rideId?: string | null;
    interstateDepartureId?: string | null;
    counterpartUserId?: string | null;
    lat?: number | null;
    lng?: number | null;
    address?: string | null;
    note?: string | null;
  }) =>
    prisma.safetyAlert.create({
      data: {
        userId: params.userId,
        raisedByRole: params.raisedByRole,
        kind: params.kind ?? 'SOS',
        rideId: params.rideId ?? null,
        interstateDepartureId: params.interstateDepartureId ?? null,
        counterpartUserId: params.counterpartUserId ?? null,
        lat: params.lat ?? null,
        lng: params.lng ?? null,
        address: params.address ?? null,
        note: params.note ?? null,
      },
      include: alertWithPeople,
    }),

  /**
   * The alert this person already has open on this trip, if any.
   *
   * A panicking thumb presses a button more than once. Reusing the open alert
   * keeps one incident as one row instead of burying the operator in five
   * copies of the same emergency.
   */
  findOpenForUser: (userId: string, rideId?: string | null) =>
    prisma.safetyAlert.findFirst({
      where: {
        userId,
        status: { in: LIVE_ALERT_STATUSES },
        ...(rideId ? { rideId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: alertWithPeople,
    }),

  findById: (id: string) =>
    prisma.safetyAlert.findUnique({ where: { id }, include: alertWithPeople }),

  listForUser: (userId: string, limit = 20) =>
    prisma.safetyAlert.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: alertWithPeople,
    }),

  /**
   * Withdraw an alert the person raised themselves. Scoped to their own id so
   * one user can never close another's emergency, and only from a live status
   * so a resolved incident cannot be rewritten as a false alarm after the fact.
   */
  cancelOwn: async (params: { id: string; userId: string; reason?: string }) => {
    const result = await prisma.safetyAlert.updateMany({
      where: {
        id: params.id,
        userId: params.userId,
        status: { in: LIVE_ALERT_STATUSES },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        resolution: params.reason ?? 'Cancelled by the person who raised it',
      },
    });

    if (result.count === 0) {
      return null;
    }

    return prisma.safetyAlert.findUnique({
      where: { id: params.id },
      include: alertWithPeople,
    });
  },

  /* ── operator side ──────────────────────────────────────────────────── */

  list: (options: {
    status?: SafetyAlertStatus | 'LIVE' | 'ALL';
    limit?: number;
    cursor?: string;
  }) => {
    const status = options.status ?? 'LIVE';
    const where: Prisma.SafetyAlertWhereInput =
      status === 'ALL'
        ? {}
        : status === 'LIVE'
          ? { status: { in: LIVE_ALERT_STATUSES } }
          : { status };

    return prisma.safetyAlert.findMany({
      where,
      // Open first, then newest: an operator should never have to scroll past
      // yesterday's resolved incidents to reach the one happening right now.
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: alertWithPeople,
    });
  },

  /** Badge counts for the admin nav. */
  counts: async () => {
    const grouped = await prisma.safetyAlert.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const byStatus: Record<string, number> = {};
    for (const row of grouped) {
      byStatus[row.status] = row._count._all;
    }

    return {
      open: byStatus['OPEN'] ?? 0,
      acknowledged: byStatus['ACKNOWLEDGED'] ?? 0,
      resolved: byStatus['RESOLVED'] ?? 0,
      cancelled: byStatus['CANCELLED'] ?? 0,
      /** What the bell shows: everything still waiting on a human. */
      live: (byStatus['OPEN'] ?? 0) + (byStatus['ACKNOWLEDGED'] ?? 0),
    };
  },

  /** "I have seen this and I am on it." Records who, so it is not anonymous. */
  acknowledge: async (params: { id: string; handledBy?: string | null }) => {
    const result = await prisma.safetyAlert.updateMany({
      where: { id: params.id, status: 'OPEN' },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        handledBy: params.handledBy ?? null,
      },
    });

    if (result.count === 0) {
      return null;
    }

    return prisma.safetyAlert.findUnique({
      where: { id: params.id },
      include: alertWithPeople,
    });
  },

  resolve: async (params: {
    id: string;
    handledBy?: string | null;
    resolution: string;
  }) => {
    const result = await prisma.safetyAlert.updateMany({
      where: { id: params.id, status: { in: LIVE_ALERT_STATUSES } },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolution: params.resolution,
        // An alert resolved without ever being acknowledged still deserves a
        // name against it.
        handledBy: params.handledBy ?? undefined,
        acknowledgedAt: new Date(),
      },
    });

    if (result.count === 0) {
      return null;
    }

    return prisma.safetyAlert.findUnique({
      where: { id: params.id },
      include: alertWithPeople,
    });
  },
};
