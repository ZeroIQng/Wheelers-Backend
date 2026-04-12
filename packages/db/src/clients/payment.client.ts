import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export const paymentClient = {
  recordDepositReceived: (data: {
    paymentId: string;
    userId: string;
    provider: string;
    providerReference: string;
    userWallet: string;
    amountNgn: number;
    metadata?: Record<string, unknown>;
  }) =>
    prisma.paymentRecord.upsert({
      where: { providerReference: data.providerReference },
      create: {
        paymentId: data.paymentId,
        userId: data.userId,
        provider: data.provider,
        providerReference: data.providerReference,
        userWallet: data.userWallet,
        amountNgn: data.amountNgn,
        metadata: (data.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      update: {
        paymentId: data.paymentId,
        userId: data.userId,
        provider: data.provider,
        userWallet: data.userWallet,
        amountNgn: data.amountNgn,
        metadata: (data.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    }),

  claimConversion: async (providerReference: string, leaseMs = 5 * 60 * 1000): Promise<boolean> => {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs);

    const result = await prisma.paymentRecord.updateMany({
      where: {
        providerReference,
        OR: [
          { status: 'RECEIVED' },
          {
            status: 'CONVERTING',
            conversionLeaseExpiresAt: { lt: now },
          },
        ],
      },
      data: {
        status: 'CONVERTING',
        conversionLeaseExpiresAt: leaseUntil,
      },
    });

    return result.count === 1;
  },

  markConverted: (params: {
    providerReference: string;
    amountUsdt: number;
    exchangeRate: number;
    metadata?: Record<string, unknown>;
  }) =>
    prisma.paymentRecord.update({
      where: { providerReference: params.providerReference },
      data: {
        amountUsdt: params.amountUsdt,
        exchangeRate: params.exchangeRate,
        status: 'CONVERTED',
        conversionLeaseExpiresAt: null,
        metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    }),

  releaseConversionClaim: (providerReference: string) =>
    prisma.paymentRecord.update({
      where: { providerReference },
      data: {
        status: 'RECEIVED',
        conversionLeaseExpiresAt: null,
      },
    }),
};
