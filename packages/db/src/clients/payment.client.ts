import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

export const paymentClient = {
  upsertPaymentIntent: (data: {
    paymentId: string;
    userId: string;
    provider: string;
    providerReference: string;
    sessionType: 'ONRAMP' | 'OFFRAMP';
    lifecycleStatus: 'PENDING' | 'REQUIRES_USER_ACTION' | 'PROCESSING' | 'SETTLED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
    providerStatus: string;
    userWallet: string;
    amountUsd: number;
    amountLocal?: number;
    localCurrency: string;
    cryptoCurrency: string;
    cryptoNetwork: string;
    cryptoAmount?: number;
    chain?: string;
    customerEmail?: string;
    walletTag?: string;
    settlementReference?: string;
    providerPayload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    lastSyncedAt?: Date;
    settledAt?: Date;
    failedAt?: Date;
    expiresAt?: Date;
  }) =>
    prisma.paymentIntent.upsert({
      where: { providerReference: data.providerReference },
      create: {
        paymentId: data.paymentId,
        userId: data.userId,
        provider: data.provider,
        providerReference: data.providerReference,
        sessionType: data.sessionType,
        lifecycleStatus: data.lifecycleStatus,
        providerStatus: data.providerStatus,
        userWallet: data.userWallet,
        amountUsd: data.amountUsd,
        amountLocal: data.amountLocal,
        localCurrency: data.localCurrency,
        cryptoCurrency: data.cryptoCurrency,
        cryptoNetwork: data.cryptoNetwork,
        cryptoAmount: data.cryptoAmount,
        chain: data.chain,
        customerEmail: data.customerEmail,
        walletTag: data.walletTag,
        settlementReference: data.settlementReference,
        providerPayload: (data.providerPayload ?? undefined) as Prisma.InputJsonValue | undefined,
        metadata: (data.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        lastSyncedAt: data.lastSyncedAt,
        settledAt: data.settledAt,
        failedAt: data.failedAt,
        expiresAt: data.expiresAt,
      },
      update: {
        paymentId: data.paymentId,
        userId: data.userId,
        provider: data.provider,
        sessionType: data.sessionType,
        lifecycleStatus: data.lifecycleStatus,
        providerStatus: data.providerStatus,
        userWallet: data.userWallet,
        amountUsd: data.amountUsd,
        amountLocal: data.amountLocal,
        localCurrency: data.localCurrency,
        cryptoCurrency: data.cryptoCurrency,
        cryptoNetwork: data.cryptoNetwork,
        cryptoAmount: data.cryptoAmount,
        chain: data.chain,
        customerEmail: data.customerEmail,
        walletTag: data.walletTag,
        settlementReference: data.settlementReference,
        providerPayload: (data.providerPayload ?? undefined) as Prisma.InputJsonValue | undefined,
        metadata: (data.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        lastSyncedAt: data.lastSyncedAt,
        settledAt: data.settledAt,
        failedAt: data.failedAt,
        expiresAt: data.expiresAt,
      },
    }),

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

  markIntentSettled: (providerReference: string, settledAt = new Date()) =>
    prisma.paymentIntent.update({
      where: { providerReference },
      data: {
        lifecycleStatus: 'SETTLED',
        settledAt,
      },
    }),
};
