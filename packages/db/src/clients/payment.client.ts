import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export const paymentClient = {
  recordSettlementReceived: (data: {
    paymentId: string;
    userId: string;
    provider: string;
    providerReference: string;
    userWallet: string;
    amountLocal: number;
    localCurrency: string;
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
        amountLocal: data.amountLocal,
        localCurrency: data.localCurrency,
        metadata: (data.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      update: {
        paymentId: data.paymentId,
        userId: data.userId,
        provider: data.provider,
        userWallet: data.userWallet,
        amountLocal: data.amountLocal,
        localCurrency: data.localCurrency,
        metadata: (data.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    }),

  claimSettlement: async (providerReference: string, leaseMs = 5 * 60 * 1000): Promise<boolean> => {
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

  markSettled: (params: {
    providerReference: string;
    amountUsdt: number;
    exchangeRate?: number;
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

  releaseSettlementClaim: (providerReference: string) =>
    prisma.paymentRecord.update({
      where: { providerReference },
      data: {
        status: 'RECEIVED',
        conversionLeaseExpiresAt: null,
      },
    }),
};
