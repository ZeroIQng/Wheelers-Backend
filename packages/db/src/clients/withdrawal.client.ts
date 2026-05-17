import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

type TxClient = Prisma.TransactionClient;

function asJson(value: Record<string, unknown> | undefined) {
  return (value ?? undefined) as Prisma.InputJsonValue | undefined;
}

export const withdrawalClient = {
  reserve: async (input: {
    userId: string;
    walletId: string;
    requestedAmountNgn: number;
    reservedAmountUsdt: number;
    displayCurrency: string;
    displayExchangeRate: number;
    payoutCurrency: string;
    cryptoCurrency: string;
    cryptoNetwork: string;
    bankAccountNumber: string;
    bankAccountName: string;
    bankNetworkId: string;
  }) =>
    prisma.$transaction(async (tx: TxClient) => {
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { id: input.walletId },
      });

      const availableUsdt = Number(wallet.balanceUsdt);
      if (availableUsdt < input.reservedAmountUsdt) {
        throw new Error('Insufficient wallet balance for this withdrawal.');
      }

      const withdrawalId = randomUUID();
      const reservationId = randomUUID();

      const updatedWallet = await tx.wallet.update({
        where: { id: input.walletId },
        data: {
          balanceUsdt: { decrement: input.reservedAmountUsdt },
          lockedUsdt: { increment: input.reservedAmountUsdt },
        },
      });

      const reservation = await tx.walletReservation.create({
        data: {
          id: reservationId,
          walletId: input.walletId,
          userId: input.userId,
          kind: 'WITHDRAWAL',
          status: 'ACTIVE',
          amountUsdt: input.reservedAmountUsdt,
          referenceId: withdrawalId,
        },
      });

      const request = await tx.withdrawalRequest.create({
        data: {
          id: withdrawalId,
          userId: input.userId,
          walletId: input.walletId,
          reservationId,
          status: 'FUNDS_RESERVED',
          requestedAmountNgn: input.requestedAmountNgn,
          reservedAmountUsdt: input.reservedAmountUsdt,
          displayCurrency: input.displayCurrency,
          displayExchangeRate: input.displayExchangeRate,
          payoutCurrency: input.payoutCurrency,
          cryptoCurrency: input.cryptoCurrency,
          cryptoNetwork: input.cryptoNetwork,
          bankAccountNumber: input.bankAccountNumber,
          bankAccountName: input.bankAccountName,
          bankNetworkId: input.bankNetworkId,
        },
      });

      return {
        wallet: updatedWallet,
        reservation,
        request,
      };
    }),

  attachOfframp: async (input: {
    withdrawalRequestId: string;
    paymentId: string;
    providerReference: string;
    quotedAmountNgn?: number;
    quotedAmountUsd?: number;
    quotedCryptoAmount?: number;
    providerPayload?: Record<string, unknown>;
    expiresAt?: Date;
  }) =>
    prisma.withdrawalRequest.update({
      where: { id: input.withdrawalRequestId },
      data: {
        paymentId: input.paymentId,
        providerReference: input.providerReference,
        quotedAmountNgn: input.quotedAmountNgn,
        quotedAmountUsd: input.quotedAmountUsd,
        quotedCryptoAmount: input.quotedCryptoAmount,
        providerPayload: asJson(input.providerPayload),
        expiresAt: input.expiresAt,
        status: 'OFFRAMP_CREATED',
      },
    }),

  markProcessing: async (providerReference: string) =>
    prisma.withdrawalRequest.updateMany({
      where: {
        providerReference,
        status: {
          in: ['FUNDS_RESERVED', 'OFFRAMP_CREATED', 'PENDING'],
        },
      },
      data: {
        status: 'PROCESSING',
      },
    }),

  releaseFailedRequest: async (params: {
    withdrawalRequestId?: string;
    providerReference?: string;
    failureReason: string;
    status: 'FAILED' | 'EXPIRED' | 'CANCELLED';
  }) =>
    prisma.$transaction(async (tx: TxClient) => {
      const request = await tx.withdrawalRequest.findFirst({
        where: params.withdrawalRequestId
          ? { id: params.withdrawalRequestId }
          : { providerReference: params.providerReference },
        include: {
          reservation: true,
          wallet: true,
        },
      });

      if (!request) {
        return null;
      }

      if (request.status === 'SETTLED') {
        return request;
      }

      if (request.reservation.status === 'ACTIVE') {
        await tx.wallet.update({
          where: { id: request.walletId },
          data: {
            balanceUsdt: { increment: Number(request.reservedAmountUsdt) },
            lockedUsdt: { decrement: Number(request.reservedAmountUsdt) },
          },
        });

        await tx.walletReservation.update({
          where: { id: request.reservationId },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
          },
        });
      }

      return tx.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: params.status,
          failureReason: params.failureReason,
          failedAt: new Date(),
          releasedAt: new Date(),
        },
      });
    }),

  settle: async (providerReference: string) =>
    prisma.$transaction(async (tx: TxClient) => {
      const request = await tx.withdrawalRequest.findFirst({
        where: { providerReference },
        include: {
          reservation: true,
          wallet: true,
        },
      });

      if (!request) {
        return null;
      }

      if (request.status === 'SETTLED') {
        return request;
      }

      if (request.reservation.status !== 'ACTIVE') {
        throw new Error('Withdrawal reservation is not active.');
      }

      const wallet = await tx.wallet.update({
        where: { id: request.walletId },
        data: {
          lockedUsdt: { decrement: request.reservedAmountUsdt },
        },
      });

      await tx.transaction.create({
        data: {
          walletId: request.walletId,
          type: 'WITHDRAWAL',
          direction: 'DEBIT',
          amountUsdt: request.reservedAmountUsdt,
          balanceAfter: wallet.balanceUsdt,
          referenceId: request.id,
          metadata: asJson({
            providerReference: request.providerReference,
            paymentId: request.paymentId,
            quotedAmountNgn: Number(request.quotedAmountNgn ?? request.requestedAmountNgn),
            payoutCurrency: request.payoutCurrency,
            bankNetworkId: request.bankNetworkId,
          }),
        },
      });

      await tx.walletReservation.update({
        where: { id: request.reservationId },
        data: {
          status: 'CONSUMED',
          consumedAt: new Date(),
        },
      });

      return tx.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: 'SETTLED',
          settledAt: new Date(),
          failureReason: null,
        },
      });
    }),

  listByUser: (userId: string, limit = 20, cursor?: string) =>
    prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  findById: (id: string) =>
    prisma.withdrawalRequest.findUnique({
      where: { id },
    }),

  findByProviderReference: (providerReference: string) =>
    prisma.withdrawalRequest.findUnique({
      where: { providerReference },
    }),
};
