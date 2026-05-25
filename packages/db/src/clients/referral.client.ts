import { Prisma, ReferralCashbackStatus, ReferralCashbackType, ReferralStatus } from '@prisma/client';
import { prisma } from '../prisma';

const RIDE_QUALIFIED_REWARD_NGN = new Prisma.Decimal(1000);
const NO_RIDE_EXPIRED_REWARD_NGN = new Prisma.Decimal(500);
const CASHBACK_FREEZE_DAYS = 30;
const REFERRAL_REWARD_DAYS = 30;
const REFERRAL_CLOSE_DAYS = 60;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function decimalToNumber(value: Prisma.Decimal | null | undefined): number {
  if (!value) return 0;
  return Number(value.toString());
}

function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildReferralCodeCandidate(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = 'WHL';
  for (let index = 0; index < 6; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

async function createCashback(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    sourceReferralId: string;
    type: ReferralCashbackType;
    amountNgn: Prisma.Decimal;
    now: Date;
  },
) {
  return tx.referralCashback.create({
    data: {
      userId: input.userId,
      sourceReferralId: input.sourceReferralId,
      type: input.type,
      amountNgn: input.amountNgn,
      remainingAmountNgn: input.amountNgn,
      status: ReferralCashbackStatus.AVAILABLE,
      freezesAt: addDays(input.now, CASHBACK_FREEZE_DAYS),
    },
  });
}

async function settleReferralWithReward(
  tx: Prisma.TransactionClient,
  input: {
    referralId: string;
    status: ReferralStatus.QUALIFIED_RIDE | ReferralStatus.EXPIRED_NO_RIDE;
    firstRideId?: string;
    amountNgn: Prisma.Decimal;
    type: ReferralCashbackType;
    now: Date;
  },
): Promise<boolean> {
  const referral = await tx.referral.findUnique({
    where: { id: input.referralId },
  });

  if (!referral || referral.status !== ReferralStatus.PENDING) {
    return false;
  }

  const existingCashback = await tx.referralCashback.findFirst({
    where: { sourceReferralId: referral.id },
    select: { id: true },
  });

  if (existingCashback) {
    await tx.referral.update({
      where: { id: referral.id },
      data: {
        status: input.status,
        firstRideId: input.firstRideId ?? referral.firstRideId,
        qualifiedAt:
          input.status === ReferralStatus.QUALIFIED_RIDE
            ? input.now
            : referral.qualifiedAt,
        settledAt: input.now,
      },
    });
    return false;
  }

  await createCashback(tx, {
    userId: referral.referrerId,
    sourceReferralId: referral.id,
    type: input.type,
    amountNgn: input.amountNgn,
    now: input.now,
  });

  await tx.referral.update({
    where: { id: referral.id },
    data: {
      status: input.status,
      firstRideId: input.firstRideId ?? referral.firstRideId,
      qualifiedAt:
        input.status === ReferralStatus.QUALIFIED_RIDE
          ? input.now
          : referral.qualifiedAt,
      settledAt: input.now,
    },
  });

  return true;
}

export const referralClient = {
  normalizeCode: normalizeReferralCode,

  async ensureCodeForUser(userId: string) {
    const existing = await prisma.referralCode.findUnique({
      where: { userId },
    });

    if (existing) return existing;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await prisma.referralCode.create({
          data: {
            userId,
            code: buildReferralCodeCandidate(),
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Could not create a unique referral code.');
  },

  async findSummary(userId: string) {
    const [code, referrals, cashbackGroups] = await Promise.all([
      this.ensureCodeForUser(userId),
      prisma.referral.groupBy({
        by: ['status'],
        where: { referrerId: userId },
        _count: { _all: true },
      }),
      prisma.referralCashback.groupBy({
        by: ['status'],
        where: { userId },
        _sum: { remainingAmountNgn: true },
        _count: { _all: true },
      }),
    ]);

    const referralCount = (status: ReferralStatus) =>
      referrals.find((group) => group.status === status)?._count._all ?? 0;
    const cashbackAmount = (status: ReferralCashbackStatus) =>
      decimalToNumber(
        cashbackGroups.find((group) => group.status === status)?._sum
          .remainingAmountNgn,
      );

    return {
      code: code.code,
      availableCashbackNgn: cashbackAmount(ReferralCashbackStatus.AVAILABLE),
      frozenCashbackNgn: cashbackAmount(ReferralCashbackStatus.FROZEN),
      usedCashbackNgn: cashbackAmount(ReferralCashbackStatus.USED),
      pendingReferrals: referralCount(ReferralStatus.PENDING),
      qualifiedReferrals: referralCount(ReferralStatus.QUALIFIED_RIDE),
      expiredNoRideReferrals: referralCount(ReferralStatus.EXPIRED_NO_RIDE),
      closedReferrals: referralCount(ReferralStatus.CLOSED),
    };
  },

  async applyCode(input: { referredUserId: string; code: string; now?: Date }) {
    const now = input.now ?? new Date();
    const code = normalizeReferralCode(input.code);
    if (!code) {
      throw new Error('Referral code is required.');
    }

    return prisma.$transaction(async (tx) => {
      const referralCode = await tx.referralCode.findFirst({
        where: { code, isActive: true },
      });

      if (!referralCode) {
        throw new Error('Referral code was not found.');
      }

      if (referralCode.userId === input.referredUserId) {
        throw new Error('You cannot use your own referral code.');
      }

      const existingReferral = await tx.referral.findUnique({
        where: { referredUserId: input.referredUserId },
      });

      if (existingReferral) {
        throw new Error('A referral code has already been applied.');
      }

      const frozenCashback = await tx.referralCashback.findFirst({
        where: {
          userId: referralCode.userId,
          status: ReferralCashbackStatus.FROZEN,
          remainingAmountNgn: { gt: new Prisma.Decimal(0) },
        },
        orderBy: [{ frozenAt: 'asc' }, { createdAt: 'asc' }],
      });

      const referral = await tx.referral.create({
        data: {
          referrerId: referralCode.userId,
          referredUserId: input.referredUserId,
          code: referralCode.code,
          appliedAt: now,
          expiresAt: addDays(now, REFERRAL_REWARD_DAYS),
          closesAt: addDays(now, REFERRAL_CLOSE_DAYS),
          usedToUnlockCashbackId: frozenCashback?.id,
          unlockedAmountNgn: frozenCashback?.remainingAmountNgn,
        },
      });

      if (frozenCashback) {
        await tx.referralCashback.update({
          where: { id: frozenCashback.id },
          data: {
            status: ReferralCashbackStatus.AVAILABLE,
            frozenAt: null,
            freezesAt: addDays(now, CASHBACK_FREEZE_DAYS),
          },
        });

        await tx.referralCashbackUnlock.create({
          data: {
            referralId: referral.id,
            cashbackId: frozenCashback.id,
            amountNgn: frozenCashback.remainingAmountNgn,
          },
        });
      }

      return {
        referral,
        unlockedCashback: frozenCashback
          ? {
              id: frozenCashback.id,
              amountNgn: decimalToNumber(frozenCashback.remainingAmountNgn),
            }
          : null,
      };
    });
  },

  listReferrals(userId: string, limit = 30) {
    return prisma.referral.findMany({
      where: { referrerId: userId },
      orderBy: { appliedAt: 'desc' },
      take: limit,
      include: {
        referredUser: {
          select: {
            id: true,
            username: true,
            name: true,
            phone: true,
            email: true,
          },
        },
      },
    });
  },

  listCashback(userId: string, limit = 50) {
    return prisma.referralCashback.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        sourceReferral: {
          select: {
            id: true,
            status: true,
            referredUserId: true,
            appliedAt: true,
          },
        },
      },
    });
  },

  async freezeExpiredCashbacks(now = new Date()) {
    const result = await prisma.referralCashback.updateMany({
      where: {
        status: ReferralCashbackStatus.AVAILABLE,
        remainingAmountNgn: { gt: new Prisma.Decimal(0) },
        freezesAt: { lte: now },
      },
      data: {
        status: ReferralCashbackStatus.FROZEN,
        frozenAt: now,
      },
    });

    return result.count;
  },

  async settleQualifiedRideRewards(now = new Date(), limit = 100) {
    const referrals = await prisma.referral.findMany({
      where: {
        status: ReferralStatus.PENDING,
        appliedAt: { lte: now },
      },
      orderBy: { appliedAt: 'asc' },
      take: limit,
    });

    let settledCount = 0;
    for (const referral of referrals) {
      const ride = await prisma.ride.findFirst({
        where: {
          riderId: referral.referredUserId,
          status: 'COMPLETED',
          completedAt: {
            gte: referral.appliedAt,
            lte: referral.expiresAt,
          },
        },
        orderBy: { completedAt: 'asc' },
        select: { id: true },
      });

      if (!ride) continue;

      const settled = await prisma.$transaction((tx) =>
        settleReferralWithReward(tx, {
          referralId: referral.id,
          status: ReferralStatus.QUALIFIED_RIDE,
          firstRideId: ride.id,
          amountNgn: RIDE_QUALIFIED_REWARD_NGN,
          type: ReferralCashbackType.RIDE_QUALIFIED,
          now,
        }),
      );

      if (settled) settledCount += 1;
    }

    return settledCount;
  },

  async settleExpiredNoRideRewards(now = new Date(), limit = 100) {
    const referrals = await prisma.referral.findMany({
      where: {
        status: ReferralStatus.PENDING,
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });

    let settledCount = 0;
    for (const referral of referrals) {
      const qualifyingRide = await prisma.ride.findFirst({
        where: {
          riderId: referral.referredUserId,
          status: 'COMPLETED',
          completedAt: {
            gte: referral.appliedAt,
            lte: referral.expiresAt,
          },
        },
        select: { id: true },
      });

      if (qualifyingRide) continue;

      const settled = await prisma.$transaction((tx) =>
        settleReferralWithReward(tx, {
          referralId: referral.id,
          status: ReferralStatus.EXPIRED_NO_RIDE,
          amountNgn: NO_RIDE_EXPIRED_REWARD_NGN,
          type: ReferralCashbackType.NO_RIDE_EXPIRED,
          now,
        }),
      );

      if (settled) settledCount += 1;
    }

    return settledCount;
  },

  async closeStaleReferrals(now = new Date()) {
    const result = await prisma.referral.updateMany({
      where: {
        status: ReferralStatus.PENDING,
        closesAt: { lte: now },
      },
      data: {
        status: ReferralStatus.CLOSED,
        settledAt: now,
      },
    });

    return result.count;
  },
};
