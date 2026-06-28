import { prisma } from '../prisma';
import type { RiderKycStatus } from '@prisma/client';

export const riderKycClient = {
  getStatus: (userId: string) =>
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        riderKycStatus: true,
        selfieCid: true,
        kycVerifiedAt: true,
      },
    }),

  markVerified: async (userId: string, selfieCid: string) => {
    const result = await prisma.user.updateMany({
      where: { id: userId, riderKycStatus: { not: 'VERIFIED' } },
      data: {
        riderKycStatus: 'VERIFIED',
        selfieCid,
        kycVerifiedAt: new Date(),
      },
    });
    if (result.count === 0) {
      throw new Error('User is already verified');
    }
  },

  isVerified: async (userId: string): Promise<boolean> => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { riderKycStatus: true },
    });
    return user.riderKycStatus === 'VERIFIED';
  },

  logAttempt: (data: {
    userId: string;
    status: RiderKycStatus;
    selfieKey?: string;
    livenessScore?: number;
    failureReason?: string;
    ipAddress?: string;
    userAgent?: string;
  }) => prisma.riderKycAttempt.create({ data }),
};
